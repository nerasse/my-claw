import type { Tool } from "./types.ts";

type AgentType = "main" | "general" | "research" | "cron";

// read_skill/list_skills are read-only and the system prompt tells every agent to call
// read_skill to load a skill; research agents need them or they hit unknown-tool errors.
export const READ_ONLY_TOOLS = ["read", "grep", "find", "ls", "fetch", "web_search", "list_skills", "read_skill"];
const SUBAGENT_EXCLUDED_TOOLS = ["spawn", "send", "list_agents", "kill_agent", "reset_agent", "manage_skills", "memory", "cron"];
const CRON_EXCLUDED_TOOLS = ["cron", "spawn", "send", "list_agents", "kill_agent", "reset_agent", "manage_skills", "memory"];

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

  // `disabled` is the config denylist, read live per run so a hot-reload toggle takes
  // effect on the next call. Applied on top of the per-agent exclusion lists.
  getForAgent(agentType: AgentType, disabled: readonly string[] = []): Tool[] {
    // External MCP tools go to acting agents only, never the read-only research agent.
    const dynamic = agentType === "research" ? [] : (this.dynamicProvider?.() ?? []);
    let set: Tool[];
    if (agentType === "research") {
      set = this.getByNames(READ_ONLY_TOOLS);
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
