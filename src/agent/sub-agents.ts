import type { MyClawConfig } from "../config.ts";
import type { ToolRegistry } from "../tools/registry.ts";

type SubAgentType = "general" | "research";

interface SubAgent {
  id: string;
  type: SubAgentType;
  depth: number;
}

const MAX_SUB_AGENTS = 3;
const MAX_DEPTH = 2;

export class SubAgentManager {
  private active: SubAgent[] = [];

  constructor(
    private config: MyClawConfig,
    private toolRegistry: ToolRegistry,
  ) {}

  canSpawn(depth: number): boolean {
    return this.active.length < MAX_SUB_AGENTS && depth < MAX_DEPTH;
  }

  spawn(type: SubAgentType, parentDepth: number): SubAgent | null {
    if (!this.canSpawn(parentDepth)) {
      return null;
    }

    const agent: SubAgent = {
      id: crypto.randomUUID(),
      type,
      depth: parentDepth + 1,
    };

    this.active.push(agent);
    return agent;
  }

  release(id: string): void {
    this.active = this.active.filter((a) => a.id !== id);
  }

  getTools(type: SubAgentType) {
    return this.toolRegistry.getForAgent(type);
  }

  getLlmConfig(type: SubAgentType) {
    const agentConfig = this.config.agents[type];
    return agentConfig?.llm ?? this.config.llm;
  }
}
