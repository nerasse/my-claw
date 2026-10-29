import { type Tool, type ToolResult, str, strOpt } from "./types.ts";
import { SubAgentRunner } from "../subagents/runner.ts";
import { SubAgentRegistry } from "../subagents/registry.ts";
import type { SubAgentDetail } from "../subagents/types.ts";

/**
 * The persistent sub-agents this conversation can reach: list them, look at one, delete one, or
 * clear its history. One tool for the actions of the same shape, called rarely; `spawn` and `send`
 * stay their own -- docs/subagents.md.
 *
 * The list is filterable because a long-running install has dozens of shared workers and a parent
 * looking for the one it just drove had to read the whole roster to find it. The filters are plain
 * substring matches on the fields the roster already carries, never a query language.
 */
export function createAgentsTool(runner: SubAgentRunner, registry: SubAgentRegistry): Tool {
  return {
    name: "agents",
    description:
      "The persistent sub-agents this conversation can reach. action='list': their ID, display name, type, " +
      "message count, status and visibility (a sub-agent private to another conversation, or scoped to another " +
      "workspace, is not listed); filter with query/status/type, page with limit/offset. " +
      "action='inspect' (id): one agent in detail -- how its last run ended (complete, failed, blocked on a " +
      "quota, lost), its last tool, whether a resume would find anything, and what to do next. " +
      "action='kill' (id): delete one permanently, its session history included; its workspace directory is NOT " +
      "touched. action='reset' (id): archive then clear its history, keeping its name, type and workspace directory.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "inspect", "kill", "reset"] },
        id: { type: "string", description: "Sub-agent session ID, for inspect, kill and reset (e.g. 'subagent/researcher-a7b3')" },
        query: { type: "string", description: "list: only the agents whose ID, display name or type contains this text." },
        status: { type: "string", enum: ["running", "idle"], description: "list: only the agents in this state." },
        type: { type: "string", description: "list: only the agents of this kind (e.g. general, research, browser)." },
        limit: { type: "number", description: "list: at most this many rows (default 50, max 200)." },
        offset: { type: "number", description: "list: skip this many rows first, for the next page." },
      },
      required: ["action"],
    },
    async execute(args): Promise<ToolResult> {
      const action = str(args, "action");
      const caller = typeof args["__sessionId"] === "string" ? args["__sessionId"] : "";
      try {
        if (action === "list") return await listAgents(runner, registry, caller, args);
        if (action === "inspect") {
          const id = str(args, "id");
          if (!id) return { success: false, output: "", error: "inspect needs the sub-agent's id (action='list' shows them)." };
          const detail = await runner.inspect(id, registry, caller);
          if (!detail) return { success: false, output: "", error: `Sub-agent ${id} not found.` };
          return { success: true, output: describe(detail) };
        }
        if (action !== "kill" && action !== "reset") {
          return { success: false, output: "", error: `Unknown action "${action}": use list, inspect, kill or reset.` };
        }
        const id = str(args, "id");
        if (!id) return { success: false, output: "", error: `${action} needs the sub-agent's id (action='list' shows them).` };
        const result = action === "kill" ? await runner.kill(id, caller) : await runner.reset(id, caller);
        const failed = result.startsWith("Error:");
        return { success: !failed, output: result, error: failed ? result : undefined };
      } catch (e) {
        return { success: false, output: "", error: String(e) };
      }
    },
  };
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

async function listAgents(
  runner: SubAgentRunner,
  registry: SubAgentRegistry,
  caller: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const all = await runner.list(registry, caller);
  const query = (strOpt(args, "query") ?? "").trim().toLowerCase();
  const status = strOpt(args, "status");
  const type = strOpt(args, "type");
  const matched = all.filter((a) => {
    if (status && a.status !== status) return false;
    if (type && a.type !== type) return false;
    if (!query) return true;
    return a.id.toLowerCase().includes(query) || a.displayName.toLowerCase().includes(query) || a.type.toLowerCase().includes(query);
  });
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(args["limit"]) || DEFAULT_LIMIT));
  const offset = Math.max(0, Number(args["offset"]) || 0);
  const page = matched.slice(offset, offset + limit);
  const lines = page.map((a) => {
    const scope = a.visibility === "workspace" ? `workspace:${a.workspaceKey ?? "default"}` : a.visibility;
    const model = a.model ? ` | ${a.model}` : "";
    return `- ${a.id} | ${a.displayName} | ${a.type} | ${a.messageCount} messages | ${a.status} | ${scope}${model}`;
  });
  // What the page is a page of. A caller told "50 agents" when 60 matched reads a filter as a total.
  const footer = matched.length > offset + page.length
    ? `\n\n${page.length} of ${matched.length} matching agents. Next page: offset=${offset + page.length}.`
    : "";
  const output = lines.join("\n") || (all.length === 0 ? "No persistent sub-agents." : "No agent matches those filters.");
  return { success: true, output: `${output}${footer}` };
}

/** One agent as a caller reads it: identity, then state, then the fields a decision needs. */
function describe(detail: SubAgentDetail): string {
  const scope = detail.visibility === "workspace" ? `workspace:${detail.workspaceKey ?? "default"}` : detail.visibility;
  const lines = [
    `${detail.id} | ${detail.displayName} | ${detail.type}`,
    `state: ${detail.lifecycle}${detail.status === "running" ? " (a run is in flight)" : ""}`,
    `messages: ${detail.messageCount} | visibility: ${scope}`,
    ...(detail.model ? [`model: ${detail.model}${detail.fallbackPolicy === "forbid" ? " (fallback forbidden)" : ""}`] : []),
    ...(detail.lastTool ? [`last tool: ${detail.lastTool.name} (${detail.lastTool.ok ? "ok" : "failed"})`] : []),
    ...(detail.quotaRetry
      ? [`quota wait: next attempt ${detail.quotaRetry.at}, attempt ${detail.quotaRetry.attempts}, windows ${detail.quotaRetry.windows.join(", ")}`]
      : []),
    `resumable: ${detail.resumable ? "yes -- send(id) with no message picks it up where it stopped" : "no"}`,
    `next: ${detail.nextActions.join("; ")}`,
  ];
  return lines.join("\n");
}
