// Summit MCP server — wires the tool definitions onto an MCP stdio server.

import { createRequire } from "node:module";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createTools, log, startupLog } from "./tools.js";

const { version } = createRequire(import.meta.url)("../package.json");

const INSTRUCTIONS = `Summit MCP server.

Exposes Summit conversion-audit insights to coding agents (Claude Code, Codex, Gemini CLI, …)
over the Model Context Protocol. The headline tools work off a public share token — no auth —
so a developer can hand an agent an audit link and have it implement the fixes:

    summit_get_audit(report)            -> ranked findings (selector + before/after copy + lift)
    summit_implementation_plan(report)  -> an ordered, code-ready checklist
    summit_run_audit(url, email)        -> kick off a fresh audit, returns a share link
    summit_list_findings(report, tier)  -> findings filtered to one priority tier

Optional workspace tools (need SUMMIT_API_TOKEN + SUMMIT_WORKSPACE_ID) cover the rest of the
Study → Approve → Ship loop, so an agent can drive Summit end to end:

    summit_list_sites()                       -> sites in your workspace
    summit_list_experiments(site_id)          -> experiments + status for a site
    summit_workspace_overview()               -> KPI rollup: visitors, conversions, pending reviews, winners
    summit_review_queue()                     -> everything waiting on human sign-off
    summit_approve_finding(finding_id)        -> approve a fix -> builds an A/B experiment (MUTATES)
    summit_reject_finding(finding_id)         -> dismiss a proposed fix (MUTATES)
    summit_approve_experiment(experiment_id)  -> approve a built experiment for launch (MUTATES)
    summit_launch_experiment(experiment_id)   -> start serving the A/B test live (MUTATES)
    summit_experiment_results(experiment_id)  -> Bayesian results: leader, lift, P(beat control)
    summit_site_pulse(site_id)                -> is the snippet installed & receiving data?

Per-variant tools act on ONE variant before an experiment goes live (get ids from
summit_list_variants), so an agent can fix or hand-pick variants instead of the whole set:

    summit_list_variants(experiment_id)              -> variants + keys/mutations/QA (the ids below)
    summit_regenerate_variant(variant_id)            -> regenerate just this challenger + re-QA (MUTATES)
    summit_run_variant_qa(variant_id)                -> re-run pre-launch QA for one variant (MUTATES)
    summit_discard_variant(variant_id)               -> delete one challenger, keep the rest (MUTATES)
    summit_publish_variant(experiment_id, variant_id) -> ship one variant to 100%, no A/B test (MUTATES)

Config via env:
    SUMMIT_API_BASE_URL   backend root (default http://localhost:8000)
    SUMMIT_API_TOKEN      bearer token for the authenticated workspace tools (optional)
    SUMMIT_WORKSPACE_ID   workspace UUID for the authenticated tools (optional)
    SUMMIT_HTTP_TIMEOUT   per-request timeout seconds (default 30)`;

/** Build the MCP server with all Summit tools registered. */
export function createServer({ env = process.env, fetchImpl = fetch } = {}) {
  const { config, tools } = createTools({ env, fetchImpl });
  const server = new McpServer({ name: "summit", version }, { instructions: INSTRUCTIONS });

  for (const tool of tools) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema },
      async (args) => {
        // Backend/validation failures come back as {error, detail} objects, mirroring the
        // Python server: the agent reads them as data, not as protocol-level tool errors.
        const result = await tool.handler(args ?? {});
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      },
    );
  }

  return { server, config };
}

/** Console entrypoint — runs the server over stdio. */
export async function main() {
  const { server, config } = createServer();
  startupLog(config);
  await server.connect(new StdioServerTransport());
  log("INFO", "summit-mcp ready on stdio");
}
