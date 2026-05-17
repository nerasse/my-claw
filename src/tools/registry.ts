import type { Tool } from "./types.ts";

type AgentType = "main" | "general" | "research";

const READ_ONLY_TOOLS = ["read", "grep", "find", "ls", "fetch", "web_search"];
const SUBAGENT_EXCLUDED_TOOLS = ["spawn", "send", "list_agents", "kill_agent", "reset_agent", "manage_skills", "memory"];

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  getForAgent(agentType: AgentType): Tool[] {
    if (agentType === "research") {
      return this.getByNames(READ_ONLY_TOOLS);
    }
    if (agentType === "general") {
      return Array.from(this.tools.values()).filter((t) => !SUBAGENT_EXCLUDED_TOOLS.includes(t.name));
    }
    return Array.from(this.tools.values());
  }

  private getByNames(names: string[]): Tool[] {
    return names
      .map((name) => this.tools.get(name))
      .filter((tool): tool is Tool => tool !== undefined);
  }
}
