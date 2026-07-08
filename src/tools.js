// Tool definitions + the HTTP layer they share. Handlers return plain objects (the MCP
// serialization lives in server.js) so tests can call them directly with a mock fetch.

import { z } from "zod";

import { compactReport, extractToken, filterFindings, findingsToPlan } from "./transforms.js";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
// Canonical 8-4-4-4-12 form — the only shape the Summit API ever hands out.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_URL_LEN = 2048;
const MAX_EMAIL_LEN = 254;

// stdout is reserved for the stdio MCP JSON protocol — every log line goes to stderr.
export function log(level, message) {
  process.stderr.write(`${new Date().toISOString()} ${level} summit-mcp: ${message}\n`);
}

/** True when the base URL is a non-localhost http:// origin (cleartext over the wire). */
export function baseIsCleartextRemote(apiRoot) {
  let parsed;
  try {
    parsed = new URL(apiRoot);
  } catch {
    return false;
  }
  const host = (parsed.hostname || "").replace(/^\[|\]$/g, "").toLowerCase();
  const isLocal =
    host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".localhost");
  return parsed.protocol === "http:" && !isLocal;
}

export function resolveConfig(env = process.env) {
  const timeoutRaw = env.SUMMIT_HTTP_TIMEOUT ?? "30";
  let timeoutSecs = Number(timeoutRaw);
  if (!Number.isFinite(timeoutSecs) || timeoutSecs <= 0) {
    log("WARNING", `SUMMIT_HTTP_TIMEOUT=${JSON.stringify(timeoutRaw)} is not a positive number — using 30s.`);
    timeoutSecs = 30;
  }
  return {
    apiRoot: (env.SUMMIT_API_BASE_URL || "http://localhost:8000").replace(/\/+$/, ""),
    apiToken: (env.SUMMIT_API_TOKEN || "").trim(),
    workspaceId: (env.SUMMIT_WORKSPACE_ID || "").trim(),
    timeoutSecs,
  };
}

/** Surface the resolved config and warn on a misconfigured/insecure base URL. */
export function startupLog(config) {
  log(
    "INFO",
    `API base resolved to ${config.apiRoot}/api/v1 (auth token ${config.apiToken ? "is" : "not"} configured)`,
  );
  let parsed = null;
  try {
    parsed = new URL(config.apiRoot);
  } catch {
    /* handled below */
  }
  if (!parsed || !["http:", "https:"].includes(parsed.protocol) || !parsed.hostname) {
    log(
      "WARNING",
      `SUMMIT_API_BASE_URL=${JSON.stringify(config.apiRoot)} does not look like a valid http(s) URL — backend calls will likely fail.`,
    );
  }
  // Refuse to leak a bearer token in cleartext to a remote origin.
  if (config.apiToken && baseIsCleartextRemote(config.apiRoot)) {
    log(
      "WARNING",
      `SUMMIT_API_TOKEN is set but SUMMIT_API_BASE_URL is a non-localhost http:// origin (${config.apiRoot}) — ` +
        "the bearer token would be sent in cleartext. Use https:// or unset the token.",
    );
  }
}

/**
 * Build the Summit tools bound to a config + fetch implementation.
 * Returns [{ name, description, inputSchema, handler }, …]; handlers return plain objects.
 */
export function createTools({ env = process.env, fetchImpl = fetch } = {}) {
  const config = resolveConfig(env);
  const { apiRoot, apiToken, workspaceId, timeoutSecs } = config;

  function httpError(exc, { url = "", elapsed = null, notFoundDetail = "" } = {}) {
    // Map any request failure to a structured error object — never let a raw exception
    // escape a tool call.
    const timing = elapsed !== null ? ` in ${elapsed.toFixed(2)}s` : "";
    if (exc?.name === "TimeoutError" || exc?.name === "AbortError") {
      log("WARNING", `backend timeout for ${url || "<request>"}${timing}: ${exc}`);
      return { error: "timeout", detail: `The Summit backend did not respond within ${timeoutSecs}s.` };
    }
    if (exc instanceof SyntaxError) {
      // res.json() failed — the backend replied with a non-JSON body.
      log("WARNING", `unexpected error handling ${url || "<request>"}${timing}: ${exc}`);
      return { error: "backend_unavailable", detail: "The Summit backend returned an unreadable response." };
    }
    log("WARNING", `backend unreachable for ${url || "<request>"}${timing}: ${exc}`);
    return { error: "backend_unavailable", detail: "Could not reach the Summit backend. Is it running?" };
  }

  async function statusError(res, { url = "", elapsed = null, notFoundDetail = "" } = {}) {
    const timing = elapsed !== null ? ` in ${elapsed.toFixed(2)}s` : "";
    log("WARNING", `backend returned ${res.status} for ${url || "<request>"}${timing}`);
    if (res.status === 404) {
      return { error: "not_found", detail: notFoundDetail || "The requested resource was not found." };
    }
    if (res.status === 401 || res.status === 403) {
      // A 403 can also be the plan gate (code=upgrade_required) rather than bad credentials.
      // Backend error shape: {"error": {"code": ..., "message": ...}}.
      let code = "";
      try {
        const body = await res.json();
        code = body?.error?.code || "";
      } catch {
        code = "";
      }
      if (code === "upgrade_required") {
        return { error: "upgrade_required", detail: "This action needs a paid Summit plan." };
      }
      return { error: "auth_required", detail: "The Summit backend rejected the request (not authorized)." };
    }
    if (res.status === 422) {
      return { error: "validation_error", detail: "The Summit backend rejected the request payload." };
    }
    if (res.status === 409) {
      // A conflict with the current experiment/variant state — surface the backend's code + message
      // (e.g. qa_failed, not_approved, not_editable) so the agent can act on it.
      let code = "conflict";
      let message = "";
      try {
        const body = await res.json();
        code = body?.error?.code || "conflict";
        message = body?.error?.message || "";
      } catch {
        /* keep defaults */
      }
      return { error: code, detail: message || "The action conflicts with the current experiment state." };
    }
    return { error: "backend_unavailable", detail: `The Summit backend returned HTTP ${res.status}.` };
  }

  /**
   * One backend call with the shared auth/timeout/error-mapping policy. Returns the parsed
   * JSON body, or a structured error object; `onResponse` may intercept a status first.
   */
  async function request(method, path, { params = null, json = null, notFoundDetail = "", onResponse = null } = {}) {
    let url = `${apiRoot}/api/v1${path}`;
    if (params) {
      const qs = new URLSearchParams(params).toString();
      if (qs) url += `?${qs}`;
    }
    const headers = {};
    // Only attach the bearer token over a secure transport (or to localhost). Refuse cleartext
    // transmission to a remote http:// origin so credentials are never leaked on the wire.
    if (apiToken && !baseIsCleartextRemote(apiRoot)) {
      headers.Authorization = `Bearer ${apiToken}`;
    }
    if (json !== null) headers["Content-Type"] = "application/json";

    const start = performance.now();
    const elapsed = () => (performance.now() - start) / 1000;
    let res;
    try {
      res = await fetchImpl(url, {
        method,
        headers,
        body: json !== null ? JSON.stringify(json) : undefined,
        signal: AbortSignal.timeout(timeoutSecs * 1000),
      });
    } catch (exc) {
      return httpError(exc, { url: path, elapsed: elapsed(), notFoundDetail });
    }
    if (onResponse) {
      const intercepted = onResponse(res);
      if (intercepted) return intercepted;
    }
    if (!res.ok) {
      return statusError(res, { url: path, elapsed: elapsed(), notFoundDetail });
    }
    // 204 No Content (e.g. a delete) has no JSON body to parse.
    if (res.status === 204) return { status: "ok" };
    try {
      return await res.json();
    } catch (exc) {
      // The timeout can also fire mid-body (headers arrived, body stalled) — keep it a
      // timeout error; anything else here means an unreadable (non-JSON) response.
      const isTimeout = exc?.name === "TimeoutError" || exc?.name === "AbortError";
      return httpError(isTimeout || exc instanceof SyntaxError ? exc : new SyntaxError(String(exc)), {
        url: path,
        elapsed: elapsed(),
      });
    }
  }

  /** Fetch an audit by its public share token. */
  function shared(token) {
    return request("GET", `/public/audits/shared/${encodeURIComponent(token)}`, {
      notFoundDetail: "Invalid or expired share token.",
    });
  }

  function pending(data) {
    return {
      status: data.status ?? null,
      url: data.requested_url ?? null,
      note: "Audit isn't finished yet — call summit_get_audit again in a few seconds.",
    };
  }

  /** A backend call returned a structured error object rather than audit data. */
  function isError(data) {
    return data !== null && typeof data === "object" && !Array.isArray(data) && "error" in data;
  }

  function authMissing() {
    if (!apiToken || !workspaceId) {
      return {
        error: "auth_required",
        detail: "Set SUMMIT_API_TOKEN and SUMMIT_WORKSPACE_ID to use workspace tools.",
      };
    }
    return null;
  }

  /** Fail fast on a malformed id before spending a network round-trip. */
  function badUuid(value, name) {
    if (typeof value === "string" && UUID_RE.test(value)) return null;
    return { error: "validation_error", detail: `\`${name}\` must be a UUID (got ${JSON.stringify(value)}).` };
  }

  /** Run one authenticated workspace call, mapping every failure to a structured error object. */
  function workspaceRequest(method, path, { params = null, json = null, notFoundDetail = "" } = {}) {
    const err = authMissing();
    if (err) return Promise.resolve(err);
    return request(method, `/workspaces/${workspaceId}${path}`, { params, json, notFoundDetail });
  }

  async function sharedAudit(report, transform) {
    const data = await shared(extractToken(report));
    if (isError(data)) return data;
    if (data.status !== "completed") return pending(data);
    return transform(data.report || {}, data.requested_url || "");
  }

  const tools = [
    {
      name: "summit_get_audit",
      description:
        "Fetch a Summit conversion audit by its share token or share link.\n\n" +
        "`report` accepts a raw token, a full link like `https://app/audit?r=TOKEN`, or a `/audit/TOKEN` " +
        "path. Returns the overall score/grade, what the business is, a screenshot URL of the audited " +
        "page, and ranked findings — each with a CSS selector, current vs suggested copy, the rationale, " +
        "and an estimated conversion lift. Ideal for grounding code changes in real CRO analysis.",
      inputSchema: { report: z.string().describe("Share token or share link") },
      handler: ({ report }) => sharedAudit(report, compactReport),
    },
    {
      name: "summit_implementation_plan",
      description:
        "Turn a Summit audit into an ordered, code-ready implementation plan.\n\n" +
        "Each step gives a priority tier (must_fix / should_fix / nice_to_fix), the CSS selector to " +
        "change, a concrete action, before→after copy, the rationale, and the expected lift — designed " +
        "to be executed top-to-bottom by a coding agent.",
      inputSchema: { report: z.string().describe("Share token or share link") },
      handler: ({ report }) => sharedAudit(report, findingsToPlan),
    },
    {
      name: "summit_list_findings",
      description:
        "List a Summit audit's findings, optionally filtered to one priority tier.\n\n" +
        "`tier` is one of must_fix, should_fix, nice_to_fix (empty = all).",
      inputSchema: {
        report: z.string().describe("Share token or share link"),
        tier: z.string().optional().describe("must_fix / should_fix / nice_to_fix (empty = all)"),
      },
      handler: ({ report, tier }) =>
        sharedAudit(report, (rep, url) => filterFindings(rep, tier || null, url)),
    },
    {
      name: "summit_run_audit",
      description:
        "Kick off a NEW Summit conversion audit for a URL (1 free audit per email).\n\n" +
        "Returns the share token + link; poll `summit_get_audit` with it until status == completed " +
        "(the deep, multi-section audit takes ~30–60s).",
      inputSchema: {
        url: z.string().describe("Absolute http(s):// URL of the page to audit"),
        email: z.string().describe("Email the audit is attributed to (1 free audit per email)"),
      },
      handler: async ({ url, email }) => {
        // Lightweight client-side validation before the network call. The backend
        // `public/audits` endpoint is responsible for SSRF egress filtering.
        url = (url || "").trim();
        email = (email || "").trim();
        if (!url || url.length > MAX_URL_LEN) {
          return { error: "validation_error", detail: `\`url\` is required and must be ≤ ${MAX_URL_LEN} chars.` };
        }
        let parsed = null;
        try {
          parsed = new URL(url);
        } catch {
          /* handled below */
        }
        // The explicit ^https?:// check closes WHATWG normalization holes ("http:example.com",
        // "https:/example.com") — the raw string is what gets POSTed, so it must be well-formed.
        if (!parsed || !/^https?:\/\//i.test(url) || !parsed.hostname) {
          return { error: "validation_error", detail: "`url` must be an absolute http(s):// URL." };
        }
        if (email && (email.length > MAX_EMAIL_LEN || !EMAIL_RE.test(email))) {
          return { error: "validation_error", detail: "`email` is not a valid email address." };
        }
        return request("POST", "/public/audits", {
          json: { url, email },
          onResponse: (res) =>
            res.status === 409
              ? { error: "quota_exceeded", detail: "This email already used its free audit." }
              : null,
        });
      },
    },

    // ── optional, authenticated workspace tools ────────────────────────────
    {
      name: "summit_list_sites",
      description: "List the sites in your Summit workspace. Requires SUMMIT_API_TOKEN + SUMMIT_WORKSPACE_ID.",
      inputSchema: {},
      handler: () => workspaceRequest("GET", "/sites"),
    },
    {
      name: "summit_list_experiments",
      description:
        "List experiments (with status + winner) in your workspace, optionally for one site.\n\n" +
        "Requires auth env vars. `site_id` is optional — omit to list all experiments.",
      inputSchema: { site_id: z.string().optional().describe("Site UUID (omit for all sites)") },
      handler: ({ site_id: siteId }) => {
        if (siteId) {
          const err = badUuid(siteId, "site_id");
          if (err) return err;
        }
        return workspaceRequest("GET", "/experiments", { params: siteId ? { site_id: siteId } : null });
      },
    },
    {
      name: "summit_workspace_overview",
      description:
        "KPI rollup across your workspace: visitors/conversions (7d), experiments running, " +
        "findings waiting for review, winners shipped — plus a per-site breakdown with scores.\n\n" +
        "The same numbers the dashboard's Overview screen shows. Requires auth env vars.",
      inputSchema: {},
      handler: () => workspaceRequest("GET", "/overview"),
    },
    {
      name: "summit_review_queue",
      description:
        "Everything Summit proposed that's waiting on human sign-off.\n\n" +
        "Returns `findings` (proposed fixes with predicted lift + confidence) and `experiments` " +
        "(built + QA'd, ready to launch). Pass the ids to the approve/reject tools. Requires auth env vars.",
      inputSchema: {},
      handler: () => workspaceRequest("GET", "/review-queue"),
    },
    {
      name: "summit_approve_finding",
      description:
        "Approve a proposed fix — MUTATES: spawns an A/B experiment + control and starts variant " +
        "generation. It does NOT touch the live site; the experiment still has to be approved and " +
        "launched. Get `finding_id` from summit_review_queue. Requires auth env vars + a paid plan.",
      inputSchema: { finding_id: z.string().describe("Finding UUID from summit_review_queue") },
      handler: ({ finding_id: findingId }) =>
        badUuid(findingId, "finding_id") ??
        workspaceRequest("POST", `/findings/${findingId}/approve`, {
          notFoundDetail: "No such finding in this workspace.",
        }),
    },
    {
      name: "summit_reject_finding",
      description:
        "Dismiss a proposed fix — MUTATES: marks the finding rejected so it leaves the review " +
        "queue. Requires auth env vars.",
      inputSchema: { finding_id: z.string().describe("Finding UUID from summit_review_queue") },
      handler: ({ finding_id: findingId }) =>
        badUuid(findingId, "finding_id") ??
        workspaceRequest("POST", `/findings/${findingId}/reject`, {
          notFoundDetail: "No such finding in this workspace.",
        }),
    },
    {
      name: "summit_approve_experiment",
      description:
        "Approve a built experiment — MUTATES: moves it from pending_approval to approved so it " +
        "can be launched. Requires auth env vars.",
      inputSchema: { experiment_id: z.string().describe("Experiment UUID") },
      handler: ({ experiment_id: experimentId }) =>
        badUuid(experimentId, "experiment_id") ??
        workspaceRequest("POST", `/experiments/${experimentId}/approve`, {
          notFoundDetail: "No such experiment in this workspace.",
        }),
    },
    {
      name: "summit_launch_experiment",
      description:
        "Launch an approved experiment — MUTATES: variants start serving to real visitors via the " +
        "summit.js snippet. Poll summit_experiment_results for the Bayesian verdict. Requires auth env vars.",
      inputSchema: { experiment_id: z.string().describe("Experiment UUID") },
      handler: ({ experiment_id: experimentId }) =>
        badUuid(experimentId, "experiment_id") ??
        workspaceRequest("POST", `/experiments/${experimentId}/launch`, {
          notFoundDetail: "No such experiment in this workspace.",
        }),
    },
    // ── per-variant actions (pre-live: fix or hand-pick individual variants) ──
    {
      name: "summit_list_variants",
      description:
        "List an experiment's variants (control + challengers) with each one's key, name, role, the " +
        "DOM mutations it applies, and its impression/conversion counters.\n\n" +
        "Use this to get the `variant_id`s the per-variant tools need. Requires auth env vars.",
      inputSchema: { experiment_id: z.string().describe("Experiment UUID") },
      handler: ({ experiment_id: experimentId }) =>
        badUuid(experimentId, "experiment_id") ??
        workspaceRequest("GET", `/experiments/${experimentId}/variants`, {
          notFoundDetail: "No such experiment in this workspace.",
        }),
    },
    {
      name: "summit_regenerate_variant",
      description:
        "Regenerate a SINGLE challenger in place — MUTATES: replaces just this variant's copy/mutations " +
        "(keeping the others) and re-runs its pre-launch QA. Only before the experiment goes live; the " +
        "control can't be regenerated. Get `variant_id` from summit_list_variants. Requires auth + a paid plan.",
      inputSchema: { variant_id: z.string().describe("Variant UUID from summit_list_variants") },
      handler: ({ variant_id: variantId }) =>
        badUuid(variantId, "variant_id") ??
        workspaceRequest("POST", `/variants/${variantId}/regenerate`, {
          notFoundDetail: "No such variant in this workspace.",
        }),
    },
    {
      name: "summit_run_variant_qa",
      description:
        "Re-run pre-launch QA for a SINGLE variant — MUTATES: queues a headless render that replaces " +
        "just that variant's QA verdict. Read it back with summit_list_variants. Requires auth env vars.",
      inputSchema: { variant_id: z.string().describe("Variant UUID from summit_list_variants") },
      handler: ({ variant_id: variantId }) =>
        badUuid(variantId, "variant_id") ??
        workspaceRequest("POST", `/variants/${variantId}/qa`, {
          notFoundDetail: "No such variant in this workspace.",
        }),
    },
    {
      name: "summit_discard_variant",
      description:
        "Discard a challenger variant — MUTATES: permanently deletes it (and its QA/media), keeping the " +
        "control and the other variants. Only before the experiment goes live; the control can't be " +
        "discarded. Requires auth env vars.",
      inputSchema: { variant_id: z.string().describe("Variant UUID from summit_list_variants") },
      handler: ({ variant_id: variantId }) =>
        badUuid(variantId, "variant_id") ??
        workspaceRequest("DELETE", `/variants/${variantId}`, {
          notFoundDetail: "No such variant in this workspace.",
        }),
    },
    {
      name: "summit_publish_variant",
      description:
        "Publish ONE chosen variant to 100% of traffic now — MUTATES: skips the A/B test and deploys the " +
        "variant's changes to every visitor (approved -> shipped). The experiment must be approved first. " +
        "Blocks if that variant's QA failed; pass override=true to publish anyway. Requires auth env vars.",
      inputSchema: {
        experiment_id: z.string().describe("Experiment UUID"),
        variant_id: z.string().describe("Variant UUID to ship to 100%"),
        override: z.boolean().optional().describe("Publish even if the variant's QA failed"),
      },
      handler: ({ experiment_id: experimentId, variant_id: variantId, override = false }) =>
        badUuid(experimentId, "experiment_id") ??
        badUuid(variantId, "variant_id") ??
        workspaceRequest("POST", `/experiments/${experimentId}/publish`, {
          params: override ? { override: "true" } : null,
          json: { variant_id: variantId },
          notFoundDetail: "No such experiment in this workspace.",
        }),
    },
    {
      name: "summit_experiment_results",
      description:
        "Bayesian results for an experiment: per-variant impressions/conversions/lift, the current " +
        "leader, P(beat control), and whether the result is statistically significant. Requires auth env vars.",
      inputSchema: { experiment_id: z.string().describe("Experiment UUID") },
      handler: ({ experiment_id: experimentId }) =>
        badUuid(experimentId, "experiment_id") ??
        workspaceRequest("GET", `/experiments/${experimentId}/results`, {
          notFoundDetail: "No such experiment in this workspace.",
        }),
    },
    {
      name: "summit_site_pulse",
      description:
        "Install/traffic check for a site: is the summit.js snippet receiving data, plus 7-day " +
        "visitors, conversions, and rage/dead clicks. Use after installing the snippet to verify it. " +
        "Requires auth env vars.",
      inputSchema: { site_id: z.string().describe("Site UUID") },
      handler: ({ site_id: siteId }) =>
        badUuid(siteId, "site_id") ??
        workspaceRequest("GET", `/sites/${siteId}/pulse`, {
          notFoundDetail: "No such site in this workspace.",
        }),
    },
  ];

  return { config, tools };
}
