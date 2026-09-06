import type { AgentInfo, FileAgent } from "./types.ts";

function keyFor(name: string, layer?: string): string {
  return layer ? `${layer}/${name}` : name;
}

/**
 * Agents that have a definition but are not reached through `spawn`.
 *
 * The browser runs as a sub-agent like the others, but there is one shared Chromium behind it and
 * `delegate_browser_task` is the door that frames the task, waits its turn on the browser and reads
 * the handoff back: a `spawn` of it would skip all three. It is still a real entry: `get` resolves
 * it, `/agents` and the app list it, and overriding `agents/browser.md` edits its instructions.
 * Only the spawn catalog leaves it out.
 */
const NOT_SPAWNABLE = new Set(["browser"]);

function infoOf(agent: FileAgent): AgentInfo {
  return {
    name: agent.name,
    description: agent.meta.description,
    base: agent.meta.base,
    source: agent.source,
    path: agent.path,
    ...(agent.layer ? { layer: agent.layer } : {}),
    ...(agent.meta.model ? { model: agent.meta.model } : {}),
    ...(agent.meta.workspace ? { workspace: agent.meta.workspace } : {}),
  };
}

export class AgentRegistry {
  private agents = new Map<string, FileAgent>();

  constructor(agents?: Map<string, FileAgent>) {
    if (agents) this.agents = new Map(agents);
  }

  setAll(agents: Map<string, FileAgent>): void {
    this.agents = new Map(agents);
  }

  /**
   * Resolution within one workspace's layers: the workspace's own agent shadows the shared name for
   * that workspace, the global entry (built-in/custom) remains for everyone else. A default
   * workspace run sees the default layer too. Mirrors `SkillRegistry.get`.
   */
  get(name: string, layer?: string): FileAgent | undefined {
    if (layer) {
      const scoped = this.agents.get(keyFor(name, layer));
      if (scoped) return scoped;
    }
    if (!layer) {
      const defaultLayer = this.agents.get(keyFor(name, "default"));
      if (defaultLayer) return defaultLayer;
    }
    return this.agents.get(keyFor(name));
  }

  exists(name: string, layer?: string): boolean {
    return this.get(name, layer) !== undefined;
  }

  /**
   * The agents spawnable from a run in this workspace, sorted by name so the spawn schema and the
   * `/agents` listing are stable between runs: an enum that reorders itself busts the prompt cache
   * for nothing.
   */
  list(layer?: string): AgentInfo[] {
    const effective = layer ?? "default";
    return Array.from(this.agents.values())
      .filter((agent) => agent.layer === undefined || agent.layer === effective)
      .filter((agent) => !NOT_SPAWNABLE.has(agent.name))
      .map(infoOf)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** The whole catalog, every workspace included. For browse surfaces, never for a run. */
  listAll(): AgentInfo[] {
    return Array.from(this.agents.values())
      .map(infoOf)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Every known agent name, unscoped. For the boot check that reports config entries matching nothing. */
  names(): string[] {
    return Array.from(new Set(Array.from(this.agents.values()).map((agent) => agent.name)));
  }
}
