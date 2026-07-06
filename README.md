# Summit MCP server

[![npm](https://img.shields.io/npm/v/@antmind-ai%2Fsummit-mcp)](https://www.npmjs.com/package/@antmind-ai/summit-mcp)

Bring [Summit](https://trysummit.ai)'s conversion-audit insights into your coding agent. Hand
Claude Code / Codex / Gemini CLI a Summit audit and have it implement the fixes — grounded in
real CRO analysis with exact selectors and before→after copy.

## Install

Nothing to install — any MCP client can launch it straight from npm:

```bash
npx -y @antmind-ai/summit-mcp
```

Or install the `summit-mcp` command globally:

```bash
npm install -g @antmind-ai/summit-mcp
```

Requires Node.js ≥ 18.17.

## Tools

| Tool | What it does |
|---|---|
| `summit_get_audit(report)` | Fetch an audit by share **token or link**. Returns score/grade, what the business is, a screenshot URL, and ranked findings (selector, current vs suggested copy, rationale, estimated lift). |
| `summit_implementation_plan(report)` | Turn the audit into an **ordered, code-ready checklist** — each step has a priority tier, selector, action, before→after, and expected lift. |
| `summit_list_findings(report, tier)` | Findings filtered to one tier (`must_fix` / `should_fix` / `nice_to_fix`). |
| `summit_run_audit(url, email)` | Kick off a **new** audit (1 free per email). Returns a share link to poll. |
| `summit_list_sites()` *(auth)* | Sites in your workspace. |
| `summit_list_experiments(site_id)` *(auth)* | Experiments + status/winner. |
| `summit_workspace_overview()` *(auth)* | KPI rollup: visitors/conversions (7d), running experiments, pending reviews, winners shipped. |
| `summit_review_queue()` *(auth)* | Everything waiting on human sign-off — proposed findings + built experiments. |
| `summit_approve_finding(finding_id)` *(auth, mutates)* | Approve a fix → builds an A/B experiment + variants (Pro). |
| `summit_reject_finding(finding_id)` *(auth, mutates)* | Dismiss a proposed fix. |
| `summit_approve_experiment(experiment_id)` *(auth, mutates)* | Approve a built experiment for launch. |
| `summit_launch_experiment(experiment_id)` *(auth, mutates)* | Start serving the A/B test live. |
| `summit_experiment_results(experiment_id)` *(auth)* | Bayesian verdict: leader, lift, P(beat control), significance. |
| `summit_site_pulse(site_id)` *(auth)* | Snippet install check + 7-day visitors/conversions/rage clicks. |

The first four work off a **public share token — no auth required**. The workspace tools need
`SUMMIT_API_TOKEN` + `SUMMIT_WORKSPACE_ID` and cover the full **Study → Approve → Ship** loop, so
an agent can go from audit to launched experiment to measured result without leaving the editor.
Tools marked *mutates* change workspace state (they never touch your live site directly — variants
only serve after an experiment is explicitly launched).

**Getting the two workspace values** (a **Pro** feature — minting a token requires a paid plan):
sign in and open **Settings → Summit MCP tokens** in the app to generate `SUMMIT_API_TOKEN` (shown
once) and copy your `SUMMIT_WORKSPACE_ID`. The web docs at
[trysummit.ai/docs](https://trysummit.ai/docs) walk through it and pre-fill the config with your
workspace ID. A token is scoped to a single workspace and can be revoked anytime.

## Configuration (env)

| Var | Default | Notes |
|---|---|---|
| `SUMMIT_API_BASE_URL` | `http://localhost:8000` | Summit backend root (the server appends `/api/v1`). Use `https://api.trysummit.ai` for production. |
| `SUMMIT_API_TOKEN` | – | Bearer token for the workspace tools. Generate in **Settings → Summit MCP tokens** (Pro). Optional — omit for audit-only. |
| `SUMMIT_WORKSPACE_ID` | – | Workspace UUID for the workspace tools (shown next to the token in Settings). Optional — omit for audit-only. |
| `SUMMIT_HTTP_TIMEOUT` | `30` | Per-request timeout (seconds). |

## Register with your agent

The audit tools work with just `SUMMIT_API_BASE_URL`. To unlock the workspace loop, add
`SUMMIT_API_TOKEN` + `SUMMIT_WORKSPACE_ID` (from **Settings → Summit MCP tokens**; see above).

### Claude Code
```bash
claude mcp add summit \
  --env SUMMIT_API_BASE_URL=https://api.trysummit.ai \
  --env SUMMIT_API_TOKEN=smt_your_token_here \
  --env SUMMIT_WORKSPACE_ID=your_workspace_id \
  -- npx -y @antmind-ai/summit-mcp
```

### Codex CLI — `~/.codex/config.toml`
```toml
[mcp_servers.summit]
command = "npx"
args = ["-y", "@antmind-ai/summit-mcp"]
env = { SUMMIT_API_BASE_URL = "https://api.trysummit.ai", SUMMIT_API_TOKEN = "smt_your_token_here", SUMMIT_WORKSPACE_ID = "your_workspace_id" }
```

### Gemini CLI — `~/.gemini/settings.json`
```json
{
  "mcpServers": {
    "summit": {
      "command": "npx",
      "args": ["-y", "@antmind-ai/summit-mcp"],
      "env": {
        "SUMMIT_API_BASE_URL": "https://api.trysummit.ai",
        "SUMMIT_API_TOKEN": "smt_your_token_here",
        "SUMMIT_WORKSPACE_ID": "your_workspace_id"
      }
    }
  }
}
```

(Any MCP-aware client works — point it at `npx -y @antmind-ai/summit-mcp`, or at the `summit-mcp` command if
installed globally, over stdio. Omit the token + workspace-id envs to use just the free audit tools.)

## Example agent flow

```
You: Audit https://moonsign.co.in and fix the top 3 conversion issues.

Agent → summit_run_audit(url="https://moonsign.co.in", email="me@co.com")
      ← { share_url: ".../audit?r=TOK", status: "queued" }
Agent → summit_implementation_plan(report="TOK")     # poll until completed
      ← { steps: [ { selector: "a.cta", before: "Learn more",
                     after: "Get my free reading", expected_lift_pct: 12 }, … ] }
Agent then edits the codebase per each step.
```

Or drive the whole loop against your workspace (auth env vars set):

```
You: Anything waiting on me? Approve the highest-lift fix and launch it.

Agent → summit_review_queue()
      ← { findings: [ { id: "…", title: "Weak hero CTA", estimated_lift: 14, … } ], experiments: [] }
Agent → summit_approve_finding(finding_id="…")        # builds experiment + variants
Agent → summit_approve_experiment(experiment_id="…")  # after QA
Agent → summit_launch_experiment(experiment_id="…")
      … later …
Agent → summit_experiment_results(experiment_id="…")
      ← { winner_key: "b", leader_prob: 0.97, is_significant: true }
```

## Develop

```bash
npm install
npm test          # node:test — pure transforms + mocked-fetch tool tests, no network
```

The package is plain ESM JavaScript with no build step. Runtime dependencies are just
`@modelcontextprotocol/sdk` and `zod`.

## License

[MIT](LICENSE)
