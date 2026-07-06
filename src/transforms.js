// Pure transforms turning a Summit audit report into coding-agent-ready insights.
// No network or SDK imports here so the logic is trivially unit-testable.

// Severity -> implementation priority tier.
const TIERS = [
  ["must_fix", new Set(["critical", "high"])],
  ["should_fix", new Set(["medium"])],
  ["nice_to_fix", new Set(["low"])],
];

/** Accept a raw share token, a share link (…/audit?r=TOKEN), or a /audit/TOKEN path. */
export function extractToken(value) {
  value = (value ?? "").trim();
  if (
    value.includes("://") ||
    value.startsWith("/") ||
    value.includes("?r=") ||
    value.includes("&r=")
  ) {
    let parsed = null;
    try {
      parsed = new URL(value.includes("://") ? value : `http://x/${value.replace(/^\/+/, "")}`);
    } catch {
      /* fall through to the regex below */
    }
    if (parsed) {
      // First non-blank r param — a blank `?r=&r=TOKEN` must not shadow the real one.
      const r = parsed.searchParams.getAll("r").find(Boolean);
      if (r) return r;
      const seg = parsed.pathname.replace(/\/+$/, "").split("/").pop();
      if (seg && seg !== "audit") return seg;
    } else {
      // new URL() rejects inputs a user could realistically paste — a link with leading
      // prose ("Check this: https://…?r=TOK") or a malformed port. Still pull out an
      // ?r= token if one is present.
      const m = value.match(/[?&]r=([^&#\s>]+)/);
      if (m) return m[1];
    }
  }
  return value;
}

// Match Python's round(x, 1): nearest tenth with ties to even, decided on the double's exact
// decimal expansion (scaling by 10 first is lossy and mis-rounds values like (2+2.1)/2).
function round1(x) {
  if (!Number.isFinite(x)) return x;
  const sign = x < 0 ? -1 : 1;
  const s = Math.abs(x).toFixed(20);
  if (s.includes("e")) return Math.round(x * 10) / 10; // |x| ≥ 1e21 — not a real lift value
  const dot = s.indexOf(".");
  const dec = s.slice(dot + 1);
  let tenths = BigInt(s.slice(0, dot)) * 10n + BigInt(dec[0]);
  const rest = dec.slice(1);
  const midpoint = "5".padEnd(rest.length, "0");
  if (rest > midpoint || (rest === midpoint && tenths % 2n === 1n)) tenths += 1n;
  return (sign * Number(tenths)) / 10;
}

function lift(f) {
  const lo = f.predicted_impact_low || 0;
  const hi = f.predicted_impact_high || 0;
  return round1((lo + hi) / 2);
}

function tierFor(severity) {
  for (const [name, sevs] of TIERS) {
    if (sevs.has(severity)) return name;
  }
  return "nice_to_fix";
}

/** Flatten a full audit report into a compact, ranked, agent-friendly structure. */
export function compactReport(report, requestedUrl = "") {
  const findings = report.findings || [];
  const ranked = [...findings].sort((a, b) => lift(b) - lift(a));
  return {
    url: requestedUrl,
    overall_score: report.overall_score ?? null,
    grade: report.grade ?? null,
    summary: report.summary ?? null,
    about_business: report.about_business ?? null,
    target_audience: report.target_audience ?? null,
    screenshot_url: report.screenshot_url ?? null,
    dimension_scores: report.dimension_scores || [],
    strengths: report.strengths || [],
    finding_count: ranked.length,
    findings: ranked.map((f) => ({
      title: f.title ?? null,
      tier: tierFor(f.severity),
      severity: f.severity ?? null,
      category: f.category ?? null,
      element: f.element ?? null,
      selector: f.element_selector ?? null,
      current_copy: f.current_copy ?? null,
      suggested_copy: f.suggested_copy ?? null,
      rationale: f.rationale ?? null,
      evidence: f.evidence || [],
      estimated_lift_pct: lift(f),
    })),
  };
}

function instruction(f) {
  const sel = f.selector || "the target element";
  if (f.suggested_copy) {
    return `Rewrite the copy of \`${sel}\` to: "${f.suggested_copy}".`;
  }
  return `Address "${f.title}" on \`${sel}\`. ${f.rationale || ""}`.trim();
}

/** Turn ranked findings into an ordered, prescriptive checklist a coding agent can execute. */
export function findingsToPlan(report, requestedUrl = "") {
  const compact = compactReport(report, requestedUrl);
  const steps = compact.findings.map((f, i) => ({
    step: i + 1,
    priority: f.tier,
    title: f.title,
    selector: f.selector || "(locate the relevant element)",
    change_type: f.category,
    action: instruction(f),
    before: f.current_copy,
    after: f.suggested_copy,
    why: f.rationale,
    expected_lift_pct: f.estimated_lift_pct,
  }));
  return {
    url: compact.url,
    overall_score: compact.overall_score,
    grade: compact.grade,
    summary: compact.summary,
    about_business: compact.about_business,
    total_steps: steps.length,
    steps,
  };
}

/** Compact report filtered to a single priority tier (must_fix / should_fix / nice_to_fix). */
export function filterFindings(report, tier, requestedUrl = "") {
  const compact = compactReport(report, requestedUrl);
  if (tier) {
    compact.findings = compact.findings.filter((f) => f.tier === tier);
    compact.finding_count = compact.findings.length;
  }
  return compact;
}
