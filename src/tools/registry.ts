import type { Tool } from "./types.ts";
import { scopeAllows, type AgentScope, type AgentToolType } from "../core/config.ts";

const MCP_PREFIX = "mcp__";

/**
 * Server name out of `mcp__<server>__<tool>`, or undefined for anything that is not an external MCP
 * tool. The first `__` after the prefix wins, matching how `mcpToolName` builds the name; a server
 * whose own name contained `__` would be ambiguous, and config keys are owner-chosen.
 */
function mcpServerOf(toolName: string): string | undefined {
  if (!toolName.startsWith(MCP_PREFIX)) return undefined;
  const rest = toolName.slice(MCP_PREFIX.length);
  const separator = rest.indexOf("__");
  return separator > 0 ? rest.slice(0, separator) : undefined;
}

// read_skill/list_skills are read-only and the system prompt tells every agent to call
// read_skill to load a skill; research agents need them or they hit unknown-tool errors.
export const READ_ONLY_TOOLS = ["read", "grep", "find", "ls", "fetch", "web_search", "conversation_search", "list_skills", "read_skill"];
const SUBAGENT_EXCLUDED_TOOLS = ["spawn", "send", "list_agents", "kill_agent", "reset_agent", "manage_skills", "memory", "cron"];
const CRON_EXCLUDED_TOOLS = ["cron", "spawn", "send", "list_agents", "kill_agent", "reset_agent", "manage_skills", "memory", "conversation_search"];

/**
 * Tools whose output is content my-claw did not author, so it is normalised before the model reads
 * it (invisible characters stripped -- see docs/untrusted-content.md).
 *
 * The local file tools are deliberately absent. The agent has to see a file exactly as it is, or an
 * edit round-trip would silently delete invisible characters the owner put there on purpose; for a
 * coding agent, corrupting a local file is worse than the hidden-instruction risk it would cover.
 */
const REMOTE_CONTENT_TOOLS = new Set(["fetch", "web_search", "conversation_search", "delegate_browser_task"]);

export function producesRemoteContent(toolName: string): boolean {
  return REMOTE_CONTENT_TOOLS.has(toolName)
    || toolName.startsWith("browser_")
    || toolName.startsWith(MCP_PREFIX);
}

export class ToolRegistry {
  private tools = new Map<string, Tool>();
  private dynamicProvider?: () => Tool[];

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    // Fall through to dynamic tools (MCP, plugins) so the home loop can execute a tool call by
    // name; built-ins win on a clash (MCP is namespaced mcp__*, plugins are collision-checked).
    return this.tools.get(name) ?? this.dynamicProvider?.().find((t) => t.name === name);
  }

  /** Names of the statically-registered (built-in) tools, for plugin collision checks. */
  staticNames(): string[] {
    return [...this.tools.keys()];
  }

  // Live source of extra tools discovered at runtime (external MCP servers). Read on every
  // getForAgent call so hot-reloaded connections are reflected on the next run. Both backends
  // build their tool set from getForAgent, so a single provider feeds home + SDK.
  setDynamicProvider(fn: () => Tool[]): void {
    this.dynamicProvider = fn;
  }

  /**
   * `disabled` is the config denylist, read live per run so a hot-reload toggle takes effect on the
   * next call. Applied on top of the per-agent exclusion lists.
   *
   * `mcpScope` restricts which external MCP servers reach this agent (docs/agent-scoping.md). It
   * defaults to "all" so a caller that forgets it never silently narrows an agent; the negative
   * default for the research agent lives in `resolveAgentMcp`, not here.
   */
  getForAgent(agentType: AgentToolType, disabled: readonly string[] = [], mcpScope: AgentScope = "all"): Tool[] {
    // Plugins share the dynamic provider with MCP but are not servers, so the scope must not touch
    // them: only names carrying the mcp__<server>__ namespace are filtered.
    const dynamic = (this.dynamicProvider?.() ?? []).filter((t) => {
      const server = mcpServerOf(t.name);
      return server === undefined || scopeAllows(mcpScope, server);
    });
    let set: Tool[];
    if (agentType === "research") {
      // The read-only built-in allowlist still applies. MCP used to be denied here unconditionally;
      // it now comes from the scope, which resolves to none for research unless explicitly granted.
      set = [...this.getByNames(READ_ONLY_TOOLS), ...dynamic];
    } else if (agentType === "general") {
      set = [...this.tools.values(), ...dynamic].filter((t) => !SUBAGENT_EXCLUDED_TOOLS.includes(t.name));
    } else if (agentType === "cron") {
      set = [...this.tools.values(), ...dynamic].filter((t) => !CRON_EXCLUDED_TOOLS.includes(t.name));
    } else {
      set = [...this.tools.values(), ...dynamic];
    }
    return disabled.length ? set.filter((t) => !disabled.includes(t.name)) : set;
  }

  private getByNames(names: string[]): Tool[] {
    return names
      .map((name) => this.tools.get(name))
      .filter((tool): tool is Tool => tool !== undefined);
  }
}
