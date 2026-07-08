// Tool tests: request wiring + error mapping over a mock fetch (no real network).

import assert from "node:assert/strict";
import { test } from "node:test";

import { baseIsCleartextRemote, createTools } from "../src/tools.js";

const WS = "11111111-1111-1111-1111-111111111111";
const FINDING = "22222222-2222-2222-2222-222222222222";
const EXP = "33333333-3333-3333-3333-333333333333";
const VAR = "44444444-4444-4444-4444-444444444444";

const AUTHED_ENV = {
  SUMMIT_API_BASE_URL: "http://localhost:8000",
  SUMMIT_API_TOKEN: "test-token",
  SUMMIT_WORKSPACE_ID: WS,
};

function toolMap({ env = AUTHED_ENV, fetchImpl } = {}) {
  const { tools } = createTools({ env, fetchImpl });
  return Object.fromEntries(tools.map((t) => [t.name, t.handler]));
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("workspace tools require the auth env vars", async () => {
  const tools = toolMap({
    env: { SUMMIT_API_BASE_URL: "http://localhost:8000" },
    fetchImpl: () => {
      throw new Error("network call made without auth env");
    },
  });
  const out = await tools.summit_review_queue({});
  assert.equal(out.error, "auth_required");
});

test("a bad uuid fails fast without a network call", async () => {
  const tools = toolMap({
    fetchImpl: () => {
      throw new Error("network call made for an invalid id");
    },
  });
  const out = await tools.summit_approve_finding({ finding_id: "not-a-uuid" });
  assert.equal(out.error, "validation_error");
  assert.ok(out.detail.includes("finding_id"));
});

test("approve_finding POSTs to the workspace path with the bearer token", async () => {
  const seen = {};
  const tools = toolMap({
    fetchImpl: (url, init) => {
      seen.method = init.method;
      seen.path = new URL(url).pathname;
      seen.auth = init.headers.Authorization;
      return jsonResponse(201, { id: EXP, status: "draft" });
    },
  });
  const out = await tools.summit_approve_finding({ finding_id: FINDING });
  assert.equal(seen.method, "POST");
  assert.equal(seen.path, `/api/v1/workspaces/${WS}/findings/${FINDING}/approve`);
  assert.equal(seen.auth, "Bearer test-token");
  assert.equal(out.id, EXP);
});

test("403 with code=upgrade_required maps to upgrade_required", async () => {
  const tools = toolMap({
    fetchImpl: () => jsonResponse(403, { error: { code: "upgrade_required", message: "Paid plan required" } }),
  });
  const out = await tools.summit_approve_finding({ finding_id: FINDING });
  assert.equal(out.error, "upgrade_required");
});

test("a plain 403 still maps to auth_required", async () => {
  const tools = toolMap({
    fetchImpl: () => jsonResponse(403, { error: { code: "forbidden", message: "nope" } }),
  });
  const out = await tools.summit_launch_experiment({ experiment_id: EXP });
  assert.equal(out.error, "auth_required");
});

test("experiment_results GETs the results path", async () => {
  const tools = toolMap({
    fetchImpl: (url) => {
      assert.equal(new URL(url).pathname, `/api/v1/workspaces/${WS}/experiments/${EXP}/results`);
      return jsonResponse(200, { winner_key: "b", leader_prob: 0.97, is_significant: true });
    },
  });
  const out = await tools.summit_experiment_results({ experiment_id: EXP });
  assert.equal(out.is_significant, true);
});

test("a 404 on results maps to not_found with the tool's detail", async () => {
  const tools = toolMap({
    fetchImpl: () => jsonResponse(404, { error: { code: "not_found", message: "missing" } }),
  });
  const out = await tools.summit_experiment_results({ experiment_id: EXP });
  assert.equal(out.error, "not_found");
  assert.equal(out.detail, "No such experiment in this workspace.");
});

test("the bearer token is never sent to a remote cleartext http:// origin", async () => {
  assert.equal(baseIsCleartextRemote("http://localhost:8000"), false);
  assert.equal(baseIsCleartextRemote("https://api.trysummit.ai"), false);
  assert.equal(baseIsCleartextRemote("http://api.trysummit.ai"), true);

  const seen = {};
  const tools = toolMap({
    env: { ...AUTHED_ENV, SUMMIT_API_BASE_URL: "http://api.trysummit.ai" },
    fetchImpl: (url, init) => {
      seen.auth = init.headers.Authorization;
      return jsonResponse(200, []);
    },
  });
  await tools.summit_list_sites({});
  assert.equal(seen.auth, undefined);
});

test("run_audit validates url/email before the network and maps 409 to quota_exceeded", async () => {
  const noNetwork = toolMap({
    fetchImpl: () => {
      throw new Error("network call made for invalid input");
    },
  });
  let out = await noNetwork.summit_run_audit({ url: "not-a-url", email: "me@co.com" });
  assert.equal(out.error, "validation_error");
  // WHATWG-normalizable but not absolute http(s):// — must be rejected like the Python server.
  out = await noNetwork.summit_run_audit({ url: "http:example.com", email: "me@co.com" });
  assert.equal(out.error, "validation_error");
  out = await noNetwork.summit_run_audit({ url: "https:/example.com", email: "me@co.com" });
  assert.equal(out.error, "validation_error");
  out = await noNetwork.summit_run_audit({ url: "https://x.dev", email: "not-an-email" });
  assert.equal(out.error, "validation_error");

  const tools = toolMap({
    fetchImpl: () => jsonResponse(409, { error: { code: "conflict", message: "used" } }),
  });
  out = await tools.summit_run_audit({ url: "https://x.dev", email: "me@co.com" });
  assert.equal(out.error, "quota_exceeded");
});

test("get_audit maps share-token 404s and pending audits", async () => {
  const notFound = toolMap({ fetchImpl: () => jsonResponse(404, { detail: "missing" }) });
  let out = await notFound.summit_get_audit({ report: "TOK_dead" });
  assert.equal(out.error, "not_found");
  assert.equal(out.detail, "Invalid or expired share token.");

  const pending = toolMap({
    fetchImpl: () => jsonResponse(200, { status: "processing", requested_url: "https://x.dev" }),
  });
  out = await pending.summit_get_audit({ report: "TOK_wip" });
  assert.equal(out.status, "processing");
  assert.ok(out.note.includes("summit_get_audit"));
});

test("a fetch timeout maps to a structured timeout error", async () => {
  const tools = toolMap({
    env: { ...AUTHED_ENV, SUMMIT_HTTP_TIMEOUT: "7" },
    fetchImpl: () => {
      const err = new Error("The operation was aborted due to timeout");
      err.name = "TimeoutError";
      throw err;
    },
  });
  const out = await tools.summit_list_sites({});
  assert.equal(out.error, "timeout");
  assert.ok(out.detail.includes("7s"));
});

test("a timeout while reading the response body still maps to timeout", async () => {
  const stalled = Object.assign(new Error("body read aborted"), { name: "TimeoutError" });
  const tools = toolMap({
    fetchImpl: () => ({ ok: true, status: 200, json: () => Promise.reject(stalled) }),
  });
  const out = await tools.summit_list_sites({});
  assert.equal(out.error, "timeout");
});

test("a non-JSON 200 body maps to backend_unavailable", async () => {
  const tools = toolMap({
    fetchImpl: () => new Response("<html>oops</html>", { status: 200 }),
  });
  const out = await tools.summit_list_sites({});
  assert.equal(out.error, "backend_unavailable");
  assert.ok(out.detail.includes("unreadable"));
});

// ── per-variant tools ────────────────────────────────────────────────────────
test("regenerate_variant POSTs to the variant path", async () => {
  const seen = {};
  const tools = toolMap({
    fetchImpl: (url, init) => {
      seen.method = init.method;
      seen.path = new URL(url).pathname;
      return jsonResponse(202, { status: "queued", variant_id: VAR });
    },
  });
  const out = await tools.summit_regenerate_variant({ variant_id: VAR });
  assert.equal(seen.method, "POST");
  assert.equal(seen.path, `/api/v1/workspaces/${WS}/variants/${VAR}/regenerate`);
  assert.equal(out.status, "queued");
});

test("discard_variant DELETEs and a 204 maps to {status: ok}", async () => {
  const seen = {};
  const tools = toolMap({
    fetchImpl: (url, init) => {
      seen.method = init.method;
      return new Response(null, { status: 204 });
    },
  });
  const out = await tools.summit_discard_variant({ variant_id: VAR });
  assert.equal(seen.method, "DELETE");
  assert.equal(out.status, "ok");
});

test("publish_variant POSTs the body + override query, and 409 surfaces the backend code", async () => {
  const seen = {};
  const ok = toolMap({
    fetchImpl: async (url, init) => {
      const u = new URL(url);
      seen.path = u.pathname;
      seen.override = u.searchParams.get("override");
      seen.body = JSON.parse(init.body);
      return jsonResponse(200, { status: "shipped", winner_variant_id: VAR });
    },
  });
  let out = await ok.summit_publish_variant({ experiment_id: EXP, variant_id: VAR, override: true });
  assert.equal(seen.path, `/api/v1/workspaces/${WS}/experiments/${EXP}/publish`);
  assert.equal(seen.override, "true");
  assert.deepEqual(seen.body, { variant_id: VAR });
  assert.equal(out.status, "shipped");

  const conflict = toolMap({
    fetchImpl: () => jsonResponse(409, { error: { code: "qa_failed", message: "QA failed for this variant." } }),
  });
  out = await conflict.summit_publish_variant({ experiment_id: EXP, variant_id: VAR });
  assert.equal(out.error, "qa_failed");
  assert.ok(out.detail.includes("QA failed"));
});

test("publish_variant fails fast on a bad uuid", async () => {
  const tools = toolMap({
    fetchImpl: () => {
      throw new Error("network call made for an invalid id");
    },
  });
  const out = await tools.summit_publish_variant({ experiment_id: EXP, variant_id: "not-a-uuid" });
  assert.equal(out.error, "validation_error");
  assert.ok(out.detail.includes("variant_id"));
});
