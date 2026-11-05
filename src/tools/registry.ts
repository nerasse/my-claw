import type { Tool } from "./types.ts";
import { scopeAllows, type AgentScope, type AgentToolType } from "../core/config.ts";

const MCP_PREFIX = "mcp__";

/**
 * Server name out of `mcp__<server>__<tool>`, or undefined for anything that is not an external MCP
 * tool. The first `__` after the prefix wins, matching how `mcpToolName` builds the name; a server
 * whose own name contained `__` would be ambiguous, and config keys are owner-chosen.
 */
export function mcpServerOf(toolName: string): string | undefined {
  if (!toolName.startsWith(MCP_PREFIX)) return undefined;
  const rest = toolName.slice(MCP_PREFIX.length);
  const separator = rest.indexOf("__");
  return separator > 0 ? rest.slice(0, separator) : undefined;
}

// `skills` reaches a research agent as its read-only variant, and the system prompt tells every
// agent to call it to load a skill: without it a research agent hits unknown-tool errors.
export const READ_ONLY_TOOLS = ["read", "search", "ls", "fetch", "web_search", "conversation_search", "skills"];
// `notify` reaches the owner's phone, which is the orchestrator's and the cron agent's business: a
// sub-agent is a delegated worker whose results are reported by whoever spawned it, and a worker
// that can ring the phone is a worker that can ring it fifty times.
const SUBAGENT_EXCLUDED_TOOLS = ["spawn", "send", "agents", "memory", "cron", "workspaces", "question", "notify", "approval"];

/**
 * What the cron role is never given, however a job is configured. A job has no one to ask
 * (`question`, `workspaces`), `memory` would rewrite what the owner is known for with nobody there
 * to see it, and one that could schedule jobs or edit skills would be a machine nobody can audit
 * (it gets `skills` read-only, like every agent but the orchestrator). docs/cron.md.
 */
const CRON_ALWAYS_EXCLUDED = ["cron", "memory", "workspaces", "question", "approval"];

/**
 * The two families a cron job carries a switch for. Granted unless the job turned them off: the
 * browser already worked in a job before the switches existed, and the owner asked for sub-agents
 * by default ("on, on"). The raw `browser_*` tools are never granted whatever happens -- the
 * browser agent is reached through `delegate_browser_task`, one task at a time, and handing the
 * low-level tools to a second driver would put two on one Chromium (docs/browser.md).
 */
export const CRON_CAPABILITIES = {
  subagents: ["spawn", "send", "agents"],
  browser: ["delegate_browser_task"],
} as const;

/**
 * The one family a job must ask for. The archive is global, which is exactly what a job checking
 * "was this follow-up already sent from another conversation" needs; it is off by default because
 * a job that does not need other conversations should not read them. It used to be excluded
 * outright on the ground that a job has "no conversation to search", which mistook the archive for
 * the job's own history.
 */
export const CRON_OPT_IN = { conversations: ["conversation_search"] } as const;

/**
 * Names to withhold from a job given its switches. `subagents` and `browser` are granted unless the
 * job turned them off; `conversations` is withheld unless the job turned it on, or named the tool
 * in its own `tools` list.
 */
export function cronCapabilityDeny(
  capabilities: { subagents?: boolean; browser?: boolean; conversations?: boolean } | undefined,
  tools?: readonly string[],
): string[] {
  const conversationsGranted = capabilities?.conversations === true
    || CRON_OPT_IN.conversations.some((name) => tools?.includes(name));
  return [
    ...(capabilities?.subagents === false ? CRON_CAPABILITIES.subagents : []),
    ...(capabilities?.browser === false ? CRON_CAPABILITIES.browser : []),
    ...(conversationsGranted ? [] : CRON_OPT_IN.conversations),
  ];
}

/**
 * The raw browser tools drive the one shared Chromium and are the browser agent's whole toolbox.
 * Every other agent reaches the browser through `delegate_browser_task`, which runs that agent one
 * task at a time: handing the raw tools to the orchestrator or a general sub-agent would put two
 * drivers on one browser. See docs/browser.md.
 */
export function isBrowserTool(name: string): boolean {
  return name.startsWith("browser_");
}

/**
 * The only non-browser tool the browser agent gets: reading the workspace's skills (`skills`, its
 * read-only variant), which carry the
 * rules of what it fills in (an application's wording, what never to state). Read-only, scoped by
 * the agent's `skills` like everyone's, and a skill holds no secret (those live in ~/.my-claw/.env
 * and secrets/). Nothing that writes, runs or reaches another machine: docs/browser.md.
 */
export const BROWSER_SKILL_TOOLS = ["skills"];

/** The tool names a file agent of the given base may narrow from. Exported so the app channel can
 *  offer exactly the names `getForAgent` will intersect the file's `tools:` against. */
export function baselineToolNames(base: "general" | "research" | "browser" | "node", staticNames: readonly string[]): string[] {
  if (base === "research") return READ_ONLY_TOOLS.filter((n) => staticNames.includes(n));
  if (base === "browser") return staticNames.filter((n) => isBrowserTool(n) || BROWSER_SKILL_TOOLS.includes(n));
  // A node's baseline is the live manifest of that machine, which no static list knows: the
  // editor offers nothing to narrow from, and the file's `tools:` still applies at run time.
  if (base === "node") return [];
  return staticNames.filter((n) => !SUBAGENT_EXCLUDED_TOOLS.includes(n) && !isBrowserTool(n));
}

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
  getForAgent(
    agentType: AgentToolType,
    disabled: readonly string[] = [],
    mcpScope: AgentScope = "all",
    allow?: readonly string[],
  ): Tool[] {
    // Plugins share the dynamic provider with MCP but are not servers, so the scope must not touch
    // them: only names carrying the mcp__<server>__ namespace are filtered.
    const dynamic = (this.dynamicProvider?.() ?? []).filter((t) => {
      const server = mcpServerOf(t.name);
      return server === undefined || scopeAllows(mcpScope, server);
    });
    let set: Tool[];
    if (agentType === "browser") {
      // A closed set: the browser tools and nothing else, dynamic tools included. The browser
      // agent reads untrusted pages all day; an MCP server or a plugin reached from there would
      // be one prompt injection away from the rest of the machine.
      set = [...this.tools.values()].filter((t) => isBrowserTool(t.name) || BROWSER_SKILL_TOOLS.includes(t.name));
    } else if (agentType === "main") {
      set = [...this.tools.values(), ...dynamic].filter((t) => !isBrowserTool(t.name));
    } else if (agentType === "research") {
      // The read-only built-in allowlist still applies. MCP used to be denied here unconditionally;
      // it now comes from the scope, which resolves to none for research unless explicitly granted.
      set = [...this.getByNames(READ_ONLY_TOOLS), ...dynamic];
    } else if (agentType === "node") {
      // A node agent's tools live on the remote machine, and only the bridge knows which node a
      // run belongs to: it builds the set from the connection's live manifest and passes it to the
      // model loop. Nothing here can answer it, so nothing here pretends to. docs/remote-nodes.md.
      set = [];
    } else if (agentType === "cron") {
      set = [...this.tools.values(), ...dynamic].filter((t) => !CRON_ALWAYS_EXCLUDED.includes(t.name) && !isBrowserTool(t.name));
    } else {
      // `general` and anything unrecognised. The orchestrator is the only agent granted the whole
      // registry, and it is named explicitly above: a name this chain does not know must land on a
      // sub-agent set, never on the full one. Before file-defined agents the union was closed and
      // the fallthrough was `main`, so a typo in an agent name would have handed out `spawn`,
      // `memory` and skill writes. See docs/file-agents.md.
      set = [...this.tools.values(), ...dynamic].filter((t) => !SUBAGENT_EXCLUDED_TOOLS.includes(t.name) && !isBrowserTool(t.name));
    }
    // A tool some of whose actions are the orchestrator's alone reaches everyone else read-only.
    if (agentType !== "main") set = set.map((t) => t.readOnly ?? t);
    // An agent file's `tools:` intersects the baseline, it never adds to it. A workspace is often a
    // cloned repository, so a file that could grant tools would turn `git clone` into a privilege
    // escalation; naming a tool outside the baseline drops it rather than widening the set.
    if (allow) set = set.filter((t) => allow.includes(t.name));
    return disabled.length ? set.filter((t) => !disabled.includes(t.name)) : set;
  }

  private getByNames(names: string[]): Tool[] {
    return names
      .map((name) => this.tools.get(name))
      .filter((tool): tool is Tool => tool !== undefined);
  }
}
