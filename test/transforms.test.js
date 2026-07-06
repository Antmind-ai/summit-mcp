// Pure-function tests for the Summit MCP transforms (no network, no SDK).

import assert from "node:assert/strict";
import { test } from "node:test";

import { compactReport, extractToken, filterFindings, findingsToPlan } from "../src/transforms.js";

const REPORT = {
  overall_score: 74,
  grade: "C",
  summary: "Solid but leaky funnel.",
  about_business: "An astrology SaaS.",
  screenshot_url: "http://x/media/audits/abc/desktop.png",
  strengths: ["Clear value prop"],
  findings: [
    {
      title: "Weak hero CTA",
      severity: "high",
      category: "weak_cta",
      element: "primary CTA button",
      element_selector: "a.cta",
      current_copy: "Learn more",
      suggested_copy: "Get my free reading",
      rationale: "Generic CTA loses clicks.",
      predicted_impact_low: 8,
      predicted_impact_high: 16,
      evidence: ["weak_cta_text=true"],
    },
    {
      title: "Footer link tweak",
      severity: "low",
      category: "other",
      element_selector: "footer a",
      rationale: "Minor polish.",
      predicted_impact_low: 1,
      predicted_impact_high: 3,
    },
  ],
};

test("extractToken accepts raw tokens, share links, and paths", () => {
  assert.equal(extractToken("rawTOKEN123"), "rawTOKEN123");
  assert.equal(extractToken("https://app.summit.dev/audit?r=TOK_abc"), "TOK_abc");
  assert.equal(extractToken("/audit?r=TOK_xyz&utm=1"), "TOK_xyz");
  assert.equal(extractToken("https://app.summit.dev/audit/TOK_path"), "TOK_path");
});

test("extractToken survives pasted prose, malformed ports, and blank r params", () => {
  // Inputs new URL() rejects but the Python reference still extracts from.
  assert.equal(extractToken("Check this: https://trysummit.ai/audit?r=TOK_abc"), "TOK_abc");
  assert.equal(extractToken("https://trysummit.ai:bad/audit?r=TOK_abc"), "TOK_abc");
  // A blank ?r= must not shadow the real token.
  assert.equal(extractToken("https://trysummit.ai/audit?r=&r=TOK_abc"), "TOK_abc");
});

test("lift rounding matches Python round(x, 1) — nearest tenth, ties to even", () => {
  const liftOf = (lo, hi) =>
    compactReport({ findings: [{ predicted_impact_low: lo, predicted_impact_high: hi }] })
      .findings[0].estimated_lift_pct;
  assert.equal(liftOf(2, 2.5), 2.2); // exact .25 tie → even, not half-up's 2.3
  assert.equal(liftOf(1, 1.5), 1.2);
  assert.equal(liftOf(2, 2.1), 2.0); // float mean 2.049999… must not double-round to 2.1
  assert.equal(liftOf(0, 0.1), 0.1); // float mean 0.050000…03 rounds up like Python
  assert.equal(liftOf(8, 16), 12);
});

test("compactReport ranks by lift and assigns tiers", () => {
  const c = compactReport(REPORT, "https://moonsign.co.in");
  assert.equal(c.url, "https://moonsign.co.in");
  assert.equal(c.finding_count, 2);
  // ranked by midpoint lift desc: high (12) before low (2)
  assert.deepEqual(
    c.findings.map((f) => f.estimated_lift_pct),
    [12, 2],
  );
  assert.equal(c.findings[0].tier, "must_fix");
  assert.equal(c.findings[1].tier, "nice_to_fix");
  assert.ok(c.screenshot_url.endsWith("/desktop.png"));
});

test("findingsToPlan is ordered and actionable", () => {
  const plan = findingsToPlan(REPORT, "https://moonsign.co.in");
  assert.equal(plan.total_steps, 2);
  const s1 = plan.steps[0];
  assert.equal(s1.step, 1);
  assert.equal(s1.priority, "must_fix");
  assert.equal(s1.selector, "a.cta");
  assert.ok(s1.action.includes("Get my free reading"));
  assert.equal(s1.before, "Learn more");
  assert.equal(s1.after, "Get my free reading");
  assert.equal(s1.expected_lift_pct, 12);
});

test("filterFindings filters by tier", () => {
  const must = filterFindings(REPORT, "must_fix");
  assert.equal(must.finding_count, 1);
  assert.equal(must.findings[0].title, "Weak hero CTA");
  assert.equal(filterFindings(REPORT, null).finding_count, 2);
});
