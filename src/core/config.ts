import { readFile, mkdir, copyFile, access } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { PROMPT_FILES, type PromptFile } from "../agent/prompt/files.ts";

export interface MyClawAppChannelConfig {
  enabled?: boolean;
  /** Port the WSS server binds. Defaults to 8080. Reboot-only: the socket is created at start. */
  port?: number;
  /** Paired devices: deviceId -> credentials. `token` is the shared secret the device presents. */
  devices?: Record<
    string,
    {
      token: string;
      name?: string;
      enabled?: boolean;
      /** What kind of client holds it: an app, a browser. Only ever informational. */
      kind?: "app" | "web";
      createdAt?: string;
      /** Refreshed at most once a minute: a chatty client must not rewrite the config. */
      lastSeenAt?: string;
      /**
       * Whose conversations this device opens. Devices sharing an owner share the thread list,
       * the uploaded files and the live replies, so a phone and a browser are two windows onto
       * the same chat. Defaults to the device id: an unset owner keeps the device on its own.
       */
      owner?: string;
    }
  >;
  streaming?: {
    enabled?: boolean;
    minChars?: number;
    throttleMs?: number;
  };
  /**
   * Tool approvals answered from the device (approval.request / approval.response frames).
   * Off by default: approval-required tools are denied until the app surfaces the request.
   */
  approvals?: boolean;
  files?: {
    /** Attachments above this size, in bytes, are logged with a warning and stored anyway. Defaults to 50 MB. */
    warnSizeBytes?: number;
  };
  /**
   * Device pairing over the unauthenticated /pair surface -- docs/web-pairing.md.
   * Off by default: the route does not exist until the owner opens it.
   */
  pairing?: {
    enabled?: boolean;
    /** Life of a displayed challenge. Defaults to 120 s. */
    ttlSeconds?: number;
    /** Life of a `myclaw device add` ticket. Defaults to 600 s. */
    claimTtlSeconds?: number;
    maxSessions?: number;
  };
  /** Static serving of the web client bundle -- "Serving the web client" in docs/my-claw-app-channel.md. */
  web?: {
    enabled?: boolean;
    /** Defaults to $MY_CLAW_DIR/web/current. */
    dir?: string;
    /**
     * CIDRs whose X-Forwarded-* headers are believed. Empty means none: without this, a client
     * on the LAN forges X-Forwarded-Proto and talks the server into a Secure cookie it never saw.
     */
    trustedProxies?: string[];
  };
}

export interface VoiceFeatureConfig {
  mode?: "cloud" | "local" | "auto";
}

export interface VoiceTtsConfig extends VoiceFeatureConfig {
  voice?: string;
}

export interface VoiceSttConfig extends VoiceFeatureConfig {
  echoTranscript?: boolean;
  echoFormat?: string;
  language?: string;
}

export interface VoiceConfig {
  mode?: "cloud" | "local" | "auto";
  stt?: VoiceSttConfig;
  tts?: VoiceTtsConfig;
}

export interface WebSearchConfig {
  baseUrl?: string;
  token?: string;
  language?: string;
}

export interface BrowserConfig {
  enabled?: boolean;
  sidecarUrl?: string;
  novncUrl?: string;
  viewport?: { width: number; height: number };
  maxSteps?: number;
  // Low-level escape hatches, off by default. They let the subagent finish tasks the DOM
  // tools cannot express, but the page content it reads is untrusted, so enabling them
  // widens the prompt-injection surface. Every call is written to the audit log.
  allowEval?: boolean;
  allowCdp?: boolean;
  // Glob patterns ("DOM.*", "Runtime.evaluate"). The sidecar's own denylist always wins.
  cdpAllowlist?: string[];
  downloadDir?: string;
  // Per sidecar endpoint ("navigate", "upload", ...) plus "default", in milliseconds.
  timeoutsMs?: Record<string, number>;
}

export interface LlmProviderConfig {
  // "openai" (default) = OpenAI-compatible HTTP endpoint driven by the home agent loop.
  // "codex" = OpenAI ChatGPT subscription via the Responses backend (device-code OAuth,
  // home loop with the Codex transport).
  // "anthropic" = Claude subscription on the home loop with the native Messages transport.
  // See docs/anthropic-backend.md and docs/codex-backend.md.
  type?: "openai" | "codex" | "anthropic";
  baseUrl?: string;
  apiKeyEnv?: string;
  headers?: Record<string, string>;
  // Automatic failover model if the primary errors out.
  fallbackModel?: string;
  // Auto-discover this provider's models at runtime (openai-compatible:
  // GET {baseUrl}/models). Discovered models merge with config.models (config wins on id
  // collision). See docs/model-discovery.md.
  discover?: boolean;
  // Submenu group label applied to this provider's discovered models in the picker.
  group?: string;
  // OpenAI-compatible providers only: send Anthropic-style `cache_control` breakpoints so
  // proxies that support it (LiteLLM, OpenRouter) cache the stable system+tools prefix.
  // Opt-in per provider: some strict endpoints reject unknown fields in message content.
  // Ignored on the codex (subscription) backend. See docs/prompt-caching.md.
  promptCache?: boolean;
  // Optional escape hatch for /status cost reporting: the models.dev provider id whose prices
  // apply to this endpoint. Only needed for a proxy that reveals neither its cost nor its upstream
  // in response headers -- LiteLLM reports both, so this normally stays unset.
  // See docs/status-command.md.
  pricingProvider?: string;
}

// Reasoning/thinking effort. Native on the Claude Agent SDK (query `effort`); sent as
// `reasoning_effort` to OpenAI-compatible providers only when the model opts in via
// `supportsEffort` (avoids 400s on providers that reject the param).
//
// The vocabulary, ordered bottom to top: it is what a level may be, not what a model offers. A
// model's own ladder comes from whoever describes it (docs/model-metadata.md), and `none` prunes
// reasoning rather than clearing the pin -- see EFFORT_LEVELS for the list offered when nothing
// describes a model, which stays deliberately narrower than this.
export type EffortLevel = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

/**
 * The vocabulary as a ladder, bottom to top. One ordered copy: the clamps, the discovery filter
 * and the Claude ladder all need to know which rung is next, and three private copies of an order
 * is how two of them end up disagreeing about where `minimal` sits.
 */
export const EFFORT_ORDER: readonly EffortLevel[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

export interface LlmModelConfig {
  /**
   * How the model is addressed everywhere (menus, sessions, tags, analytics). Discovery writes a
   * provider-qualified reference (`opencode_go/mimo-v2.5`) because two providers serving the same
   * name are two different prices; a model declared in config keeps the id its owner wrote. See
   * docs/model-identity.md.
   */
  id: string;
  label: string;
  /**
   * The id the provider's API knows, when `id` is qualified. Absent means the two are the same.
   */
  apiId?: string;
  provider?: string;
  // Optional submenu grouping for the model picker: models sharing a `group` value are
  // collapsed behind a single "<group> >" entry in /model. A "/"-separated value nests
  // submenus (e.g. "Claude/Opus"). Ungrouped models stay at root.
  group?: string;
  // Model family as the provider names it ("Opus", "Sonnet"). Discovery fills it in so a moving
  // alias can tell which family it tracks. Carried on the model rather than read back out of
  // `group`, which is a display choice and says nothing once the provider lists flat.
  family?: string;
  // OpenAI-compatible models only: opt in to forwarding `reasoning_effort`. Anthropic and
  // codex backends accept effort natively, so this only matters on the openai path.
  supportsEffort?: boolean;
  // Per-model supported effort levels (discovery provides these). When set, the effort
  // submenu only shows these levels instead of the full global list.
  supportedEffortLevels?: EffortLevel[];
  // Which `thinking.type` values the Anthropic Messages API accepts for this model, straight from
  // `/v1/models`. Naming an unsupported type is a 400: Opus 5 reports `enabled: false` and takes
  // `adaptive` only, so this cannot be inferred from the family or the version.
  thinkingTypes?: { adaptive: boolean; enabled: boolean };
    vision?: boolean;
    limit?: {
      context?: number;
      output?: number;
    };
    // Set when the context window was filled in from the models.dev table instead of being
    // declared or discovered, so /status can attribute a surprising number. See
    // docs/context-window.md.
    contextFrom?: "models.dev" | "openrouter" | "openrouter-endpoint";
  }

  export interface LlmConfig {
  provider?: string;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  vision?: boolean;
  limit?: {
    context?: number;
    output?: number;
  };
  models?: LlmModelConfig[];
  // Global default reasoning effort applied when a model/session does not set its own.
  effort?: EffortLevel;
  // Model id to reroute a run to when the resolved model cannot take image input. Provider
  // agnostic by design: the switch happens before the request instead of relying on
  // proxy-side fallbacks.
  visionFallback?: string;

  defaultProvider?: string;
  defaultModel?: string;
  providers?: Record<string, LlmProviderConfig>;
  // Tag aliases this view resolves through. Attached to the llm section by the boot/reload
  // sync from the top-level `tags` section; see docs/tags.md.
  tags?: Record<string, TagConfig>;
}

/**
 * A tag aliases a provider/model/effort/context combo under a name. Configs (agent pins, cron
 * jobs, session overrides) reference it as `tag:<name>`; when the underlying model changes
 * version the tag is updated once and every config follows. The name `Default` is reserved for
 * a virtual tag that always points at the current default model (never stored). Resolved in
 * `src/llm/resolver.ts`, applied to the context cap in `src/llm/context-window.ts`.
 */
export interface TagConfig {
  model: string;
  effort?: EffortLevel;
  contextCap?: number;
}

export const TAG_REF_PREFIX = "tag:";

/** The name a model id refers to when it is a tag reference, else undefined. */
export function tagNameOf(modelId: string): string | undefined {
  if (modelId.startsWith(TAG_REF_PREFIX)) return modelId.slice(TAG_REF_PREFIX.length);
  return undefined;
}

export interface ResolvedLlmConfig {
  // Which agent engine runs this model. Absent = "openai" (home loop). The dispatcher
  // routes on this before any HTTP/SDK specifics come into play. "codex" and "anthropic" run on
  // the home loop too, but the loop swaps in their own transport (docs/codex-backend.md,
  // docs/anthropic-backend.md).
  backend?: "openai" | "codex" | "anthropic";
  // Carried from discovery so the Anthropic transport can name a thinking type the model accepts.
  thinkingTypes?: { adaptive: boolean; enabled: boolean };
  /**
   * The effort ladder this model publishes, carried to the transport so a level that is not on it
   * can be clamped instead of refused. The Messages API validates per model, not per family:
   * `xhigh` on Sonnet 4.6 answers HTTP 400 "This model does not support effort level 'xhigh'.
   * Supported levels: high, low, max, medium."
   */
  effortLevels?: EffortLevel[];
  baseUrl: string;
  model: string;
  // The model id the API actually receives. When `model` is a tag reference (`tag:<name>`)
  // this is the tag's underlying model, so the request never carries the alias; analytics and
  // status keep the tag id as the run's identity. Absent = `model` is already the wire id.
  apiModel?: string;
  // The provider entry that owns this model ("default" when the config predates named
  // providers). The dispatcher compares it across resolutions to decide whether an outage on
  // this run can be rerouted to the default provider at all.
  provider?: string;
  // OpenRouter endpoint the run is pinned to ("azure/eu"), from the `@` suffix of the reference.
  // Set only for OpenRouter providers: it becomes `provider.order` on the request, and nothing
  // else understands that field. See docs/model-identity.md.
  providerRoute?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  vision?: boolean;
  limit?: {
    context?: number;
    output?: number;
  };
  fallbackModel?: string;
  // Resolved effort to apply for this run. Only set when it should actually be sent
  // (anthropic and codex always; openai-compatible only when the model opts in via supportsEffort).
  effort?: EffortLevel;
  // Send Anthropic-style `cache_control` breakpoints on the OpenAI-compatible request
  // (propagated from the provider's `promptCache`). See docs/prompt-caching.md.
  promptCache?: boolean;
}

export interface AgentLlmConfig {
  defaultProvider?: string;
  defaultModel?: string;
  // The agent's own effort pin, the sibling of defaultModel: a run on this agent uses it
  // unless a tag or the session says otherwise. See docs/agent-model.md.
  effort?: EffortLevel;
}

/** Display metadata of a config-defaultable agent, served to the phone app's settings. */
export interface AgentMeta {
  /** Display label, e.g. in the app's settings. */
  label: string;
  /** One line: what this agent is for. */
  description: string;
  /** Whose default this agent follows when it has no pin of its own. */
  inheritsFrom: "global" | "orchestrator";
}

/**
 * The one place the config-defaultable agents are named. The set is closed today; keeping the
 * list here alone means a future config-declared agent is one entry, not six lists that drift.
 */
export const AGENTS = {
  orchestrator: {
    label: "Orchestrator",
    description: "The agent you talk to",
    inheritsFrom: "global",
  },
  general: {
    label: "General sub-agent",
    description: "Spawned with full tool access",
    inheritsFrom: "global",
  },
  research: {
    label: "Research sub-agent",
    description: "Spawned with read-only tools",
    inheritsFrom: "global",
  },
  /**
   * Cron runs used to be indistinguishable from the orchestrator in config, so a scheduled job
   * could not be pinned to a cheap model without moving the owner's own default. The key is
   * optional and absent inherits the orchestrator, so adding it changed nothing that existed.
   * `maxIterations` here is ignored: cron already has `cron.maxIterations`.
   */
  cron: {
    label: "Scheduled tasks",
    description: "Jobs on a schedule",
    inheritsFrom: "orchestrator",
  },
} as const satisfies Record<string, AgentMeta>;

export type AgentConfigKey = keyof typeof AGENTS;
export const AGENT_KEYS = Object.keys(AGENTS) as AgentConfigKey[];

// The spawnable set used to live here as a hand-written literal next to AGENTS. It is now the agent
// registry (`src/agents/registry.ts`), read live: a file in `agents/` adds a spawn target without
// a release, so a constant here could only ever be a stale copy. See docs/file-agents.md.

/**
 * The tool axis. `main` is the orchestrator and `cron` a scheduled run; anything else is an agent
 * name resolved through the agent registry.
 *
 * A plain string because the set is open: a file dropped in `agents/` adds a name without a
 * release, so no union could stay true. The exhaustiveness a union used to give is replaced by
 * `resolveAgent` (`src/agents/resolve.ts`) being the single place a name is turned into behaviour.
 * See docs/file-agents.md.
 */
export type AgentToolType = string;

export interface AgentConfig {
  maxIterations?: number;
  llm?: AgentLlmConfig;
  /**
   * Context ceiling for this agent, overriding the global `context.cap`. A research sub-agent
   * reading long documents and a cron job posting a one-line summary do not want the same window.
   * `0` lifts the ceiling for this agent alone. See docs/context-window.md.
   */
  context?: { cap?: number };
  /**
   * Skill names this agent may see and read. Exact names, or the single entry `["*"]` for all.
   * Absent inherits the orchestrator's list; absent there too means all. See docs/agent-scoping.md.
   */
  skills?: string[];
  /** MCP server names whose tools reach this agent. Same semantics as `skills`. */
  mcp?: string[];
  /**
   * Workspace key (from `workspaces`) this agent runs in. Applied when a session is created,
   * so a config change moves new runs only and a live conversation never switches workspace.
   * Absent = the default workspace. See docs/multi-workspace.md.
   */
  workspace?: string;
}

/** Lazy nested AGENTS.md discovery. See `docs/nested-agents.md`. */
export interface NestedAgentsConfig {
  enabled?: boolean; // default true
  maxBytes?: number; // per-run cap on total injected nested bytes (default 32768)
}

export interface CronConfig {
  enabled?: boolean;
  tickIntervalMs?: number;
  maxIterations?: number;
  timeoutMs?: number;
}

export interface EmbeddingConfig {
  backend?: "local" | "http";
  model?: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  dimensions?: number;
}

export interface ConsolidationConfig {
  enabled?: boolean;
  every?: number;
  model?: string;
  provider?: string;
}

export interface MemoryConfig {
  enabled?: boolean;
  embedding?: EmbeddingConfig;
  consolidation?: ConsolidationConfig;
  recallMaxEntries?: number;
  recallMaxChars?: number;
  ftsCandidates?: number;
  supersededRetentionDays?: number;
}

export interface MyClawConfig {
  whitelist: string[];
  blacklist: string[];
  channels: {
    "my-claw-app"?: MyClawAppChannelConfig;
  };
  llm: LlmConfig;
  /**
   * Overrides keyed by agent name: the four reserved roles and any file-defined agent. This is an
   * override layer, not a definition layer -- an entry here retunes an agent that exists, it cannot
   * bring one into existence. Read through `agentConfigOf`, never indexed directly, so the `nested`
   * key below can never be mistaken for an agent. See docs/file-agents.md.
   */
  agents: Partial<Record<string, AgentConfig>> & {
    /** Lazy nested AGENTS.md discovery settings, not an agent. See docs/nested-agents.md. */
    nested?: NestedAgentsConfig;
  };
  voice?: VoiceConfig;
  webSearch?: WebSearchConfig;
  browser?: BrowserConfig;
  workspace?: string;
  /**
   * Named secondary workspaces, each an absolute path. A cron job or future feature references
   * the key, never the path, so moving a project is a one-line config change. The key `default`
   * is reserved for `workspace`. Hot-reloadable; see docs/multi-workspace.md.
   */
  workspaces?: Record<string, string>;
  /**
   * Per-workspace prompt policies: where each workspace reads a prompt file it does not own, keyed
   * by workspace key ("default" included). Absent = every workspace inherits from the default one,
   * which is what every workspace did before this section existed. Hot-reloadable; the loader
   * reads it live through the run's config. See docs/workspace-prompt-inheritance.md.
   */
  workspacePrompts?: Record<string, WorkspacePromptPolicy>;
  /**
   * Named model aliases: each tag pins a provider/model/effort/context combo under a name and
   * configs reference it as `tag:<name>`. Hot-reloadable; see docs/tags.md.
   */
  tags?: Record<string, TagConfig>;
  cron?: CronConfig;
  memory?: MemoryConfig;
  injection?: InjectionConfig;
  context?: ContextConfig;
  tools?: ToolsConfig;
  skills?: SkillsConfig;
  logging?: LoggingConfig;
  mcp?: Record<string, McpServerConfig>;
  /**
   * UI preferences shared by every device the app runs on, flipped from the app's Settings. The
   * server owns the persistence so a reinstall or a second device starts with the same layout.
   */
  uiPrefs?: UiPrefsConfig;
}

/** App-side display preferences, persisted on the server and broadcast to every device. */
export interface UiPrefsConfig {
  /** Keep tool cards expanded after their run settles (default: folded). */
  expandTools?: boolean;
  /** Keep the reasoning/thinking block expanded after the turn settles (default: folded). */
  expandReasoning?: boolean;
}

/** Log verbosity. `MY_CLAW_LOG_LEVEL` overrides this, so a debug session needs no config edit. */
export interface LoggingConfig {
  /** Floor for what is written to the log files. Default "info". */
  level?: "trace" | "debug" | "info" | "warn" | "error";
}

/** Skill system knobs; hot-reloadable (read live per run). */
export interface SkillsConfig {
  /**
   * Soft relevance reminder: on top of the always-present skill catalog, append a short
   * "possibly relevant" hint at the very end of the system prompt for the skills that best
   * match the incoming message. Ranking uses the memory embedding model when configured and
   * warm, otherwise a keyword fallback. See docs/skill-suggestions.md.
   */
  suggest?: SkillSuggestConfig;
}

export interface SkillSuggestConfig {
  /** Master switch. Default on (keyword fallback works with zero setup). */
  enabled?: boolean;
  /** Minimum cosine similarity for a skill to be suggested (embedding mode only). Default 0.35. */
  minScore?: number;
  /**
   * Hard cap on suggestions. When omitted it scales with the registry size:
   * clamp(round(N * 0.5), 5, 15). Set an explicit value to override the curve.
   */
  topK?: number;
}

/** Tool gating. Denylist so new in-tree tools are on by default; hot-reloadable. */
export interface ToolsConfig {
  /** Tool names filtered out of every agent's tool set. Read live per run. */
  disabled?: string[];
  /**
   * Load owner-authored tool modules from `$MY_CLAW_DIR/tools.d/` at runtime. Off by
   * default: loading arbitrary code is an in-process RCE surface. See
   * `docs/hot-reload-extensions.md`.
   */
  pluginsEnabled?: boolean;
}

/**
 * External MCP server declared in config, exposed to the agent as tools.
 * `transport` selects the wire: a stdio child process, or a remote SSE/HTTP URL.
 * See `docs/hot-reload-extensions.md`.
 */
export interface McpServerConfig {
  transport: "stdio" | "sse" | "http";
  /** stdio: executable to spawn. */
  command?: string;
  /** stdio: arguments passed to `command`. */
  args?: string[];
  /** stdio: extra env vars merged over the inherited environment. */
  env?: Record<string, string>;
  /** sse/http: server endpoint URL. */
  url?: string;
  /** sse/http: extra request headers (e.g. Authorization). */
  headers?: Record<string, string>;
  /** Set false to declare but not connect a server. Defaults to enabled. */
  enabled?: boolean;
}

/** Context weight management (pruning + auto-compaction). See `docs/context-pruning.md`. */
export interface ContextConfig {
  pruning?: ContextPruningConfig;
  autoCompact?: AutoCompactConfig;
  // Ceiling applied to every resolved context window, active without configuration. Very long
  // contexts degrade attention and bill linearly, so the window a provider allows is not
  // automatically the window we agree to use. See docs/context-window.md.
  cap?: number;
  // Glob patterns matched against the model id. A match uses the model's full window. Patterns
  // rather than exact ids because a self-hosted family can carry a dozen quantisation variants.
  capExempt?: string[];
}

export interface ContextPruningConfig {
  enabled?: boolean; // default true
  // Tokens of tool output, newest first, that are never stubbed (default 40000). A window counted
  // in turns cannot express this: five turns is a paragraph on one run and half a megabyte on the
  // next, and what has to fit is a token budget.
  protectTokens?: number;
  headChars?: number; // chars of the original output kept in the stub, split head/tail (default 400)
}

export interface AutoCompactConfig {
  enabled?: boolean; // default true
  thresholdRatio?: number; // fraction of the context limit that triggers compaction (default 0.8)
}

export const DEFAULT_PRUNING_PROTECT_TOKENS = 40_000;
export const DEFAULT_PRUNING_HEAD_CHARS = 400;
export const DEFAULT_AUTO_COMPACT_THRESHOLD = 0.8;
export const DEFAULT_CONTEXT_CAP = 512_000;

/**
 * `0` or a negative value disables the ceiling; anything else is honoured as written.
 *
 * An agent's own key wins outright rather than being combined with the global one: "this agent
 * gets 1M" has to be expressible without editing the global policy, and a min() would silently
 * refuse it.
 */
export function resolveContextCap(config: MyClawConfig, agent?: AgentToolType | "orchestrator"): number | undefined {
  const own = agent ? agentConfigOf(config, agent)?.context?.cap : undefined;
  const cap = own ?? config.context?.cap;
  if (cap === undefined) return DEFAULT_CONTEXT_CAP;
  if (!Number.isFinite(cap) || cap <= 0) return undefined;
  return Math.floor(cap);
}

export function contextPruningEnabled(config: MyClawConfig): boolean {
  return config.context?.pruning?.enabled !== false;
}

export function resolveContextPruning(config: MyClawConfig): { protectTokens: number; headChars: number } {
  const p = config.context?.pruning;
  const turns = p?.protectTokens;
  const head = p?.headChars;
  return {
    protectTokens: typeof turns === "number" && Number.isFinite(turns) && turns > 0 ? Math.floor(turns) : DEFAULT_PRUNING_PROTECT_TOKENS,
    headChars: typeof head === "number" && Number.isFinite(head) && head >= 0 ? Math.floor(head) : DEFAULT_PRUNING_HEAD_CHARS,
  };
}

export function autoCompactEnabled(config: MyClawConfig): boolean {
  return config.context?.autoCompact?.enabled !== false;
}

export function resolveAutoCompactThreshold(config: MyClawConfig): number {
  const r = config.context?.autoCompact?.thresholdRatio;
  // Above 1.0 the request would fail before compaction gets a chance to run.
  return typeof r === "number" && Number.isFinite(r) && r > 0 && r <= 1 ? r : DEFAULT_AUTO_COMPACT_THRESHOLD;
}

/** Mid-run message injection (steering). See `docs/injection.md`. */
export interface InjectionConfig {
  enabled?: boolean; // default true
  budgetBonus?: number; // extra iterations granted per injected turn (default 8)
}

export const DEFAULT_INJECTION_BUDGET_BONUS = 8;

export function injectionEnabled(config: MyClawConfig): boolean {
  return config.injection?.enabled !== false;
}

export function resolveInjectionBudgetBonus(config: MyClawConfig): number {
  const n = config.injection?.budgetBonus;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : DEFAULT_INJECTION_BUDGET_BONUS;
}

export const DEFAULT_ORCHESTRATOR_MAX_ITERATIONS = 90;
export const DEFAULT_SUBAGENT_MAX_ITERATIONS = 50;

export const DEFAULT_NESTED_AGENTS_MAX_BYTES = 32_768;

export function nestedAgentsEnabled(config: MyClawConfig): boolean {
  return config.agents?.nested?.enabled !== false;
}

export function resolveNestedAgentsMaxBytes(config: MyClawConfig): number {
  const n = config.agents?.nested?.maxBytes;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : DEFAULT_NESTED_AGENTS_MAX_BYTES;
}

/** `fileDefault` is the agent file's `maxIterations`, which sits between the config entry and the
 *  built-in default. See docs/file-agents.md. */
export function resolveMaxIterations(config: MyClawConfig, type: AgentToolType, fileDefault?: number): number {
  const agentCfg = agentConfigOf(config, type);
  if (agentCfg?.maxIterations !== undefined && Number.isFinite(agentCfg.maxIterations) && agentCfg.maxIterations > 0) {
    return agentCfg.maxIterations;
  }
  if (fileDefault !== undefined && Number.isFinite(fileDefault) && fileDefault > 0) return fileDefault;
  return configKeyForAgent(type) === "orchestrator" ? DEFAULT_ORCHESTRATOR_MAX_ITERATIONS : DEFAULT_SUBAGENT_MAX_ITERATIONS;
}

/**
 * Agent scoping. Two vocabularies exist for agents: the tool axis is
 * `main | general | research | cron` and the config axis names the keys of `AGENTS`, the one
 * table where the set lives. `main` and `orchestrator` are the same agent. Callers pass the
 * tool-axis value; the mapping below is the single place they meet.
 * See docs/agent-scoping.md.
 */

/** `"all"` is a distinct value, not a sentinel array, so it cannot be mistaken for a list. */
export type AgentScope = string[] | "all";

const SCOPE_WILDCARD = "*";

function configKeyForAgent(type: AgentToolType): string {
  // `cron` was long absent from the config axis so that no key would carry a name existing on only
  // one axis. It now has one, which brings the two axes closer instead of further apart. Absence
  // still inherits the orchestrator, so nothing that predates the key moved.
  if (type === "main") return "orchestrator";
  return type;
}

/** The config key an agent reads, in the caller's own vocabulary. `main` and `orchestrator` are one. */
export function agentConfigKey(type: AgentToolType): string {
  return configKeyForAgent(type);
}

/**
 * The config overrides for one agent. `nested` shares the `agents` namespace without being an agent,
 * so it is excluded here rather than at each of the dozen call sites -- an agent file named
 * `nested.md` is refused for the same reason, and the two guards must not disagree.
 */
export function agentConfigOf(config: MyClawConfig, type: AgentToolType): AgentConfig | undefined {
  const key = configKeyForAgent(type);
  if (key === "nested") return undefined;
  return config.agents?.[key];
}

/**
 * The agent's own model/provider defaults, or the orchestrator's when it has none. Returning
 * `undefined` rather than the global config keeps the merge in the resolver, which owns precedence.
 */
export function resolveAgentLlm(config: MyClawConfig, type: AgentToolType, fileModel?: string): AgentLlmConfig | undefined {
  const own = agentConfigOf(config, type)?.llm;
  if (own?.defaultModel !== undefined || own?.defaultProvider !== undefined) return own;
  // The agent file's `model:`, below the config entry so `/model <agent>` still wins from chat.
  if (fileModel) return { defaultModel: fileModel };
  // Only cron inherits: general and research are separate agents whose absent entry means "global
  // default", not "whatever the owner picked for the chat he is sitting in".
  if (type === "cron") return config.agents?.orchestrator?.llm;
  return undefined;
}

function normalizeScope(list: string[]): AgentScope {
  if (list.includes(SCOPE_WILDCARD)) return "all";
  return list;
}

/**
 * An empty array is a decision ("nothing"), never an unset field. Branching on `length` would read
 * `[]` as absent and grant everything to an agent meant to have nothing -- the exact opposite.
 */
function readScope(agent: AgentConfig | undefined, field: "skills" | "mcp"): AgentScope | undefined {
  const list = agent?.[field];
  return Array.isArray(list) ? normalizeScope(list) : undefined;
}

/**
 * The scope this agent's own config entry declares, with no inheritance. Exported so the file-agent
 * resolver can slot a file's scope between the config entry and the orchestrator's, which is a
 * precedence the all-in-one resolvers below cannot express.
 */
export function readAgentScope(config: MyClawConfig, type: AgentToolType, field: "skills" | "mcp"): AgentScope | undefined {
  return readScope(agentConfigOf(config, type), field);
}

/** The orchestrator's scope, the last stop before "all" for every agent that inherits. */
export function inheritedScope(config: MyClawConfig, field: "skills" | "mcp"): AgentScope | undefined {
  return readScope(config.agents?.orchestrator, field);
}

export function resolveAgentSkills(config: MyClawConfig, type: AgentToolType): AgentScope {
  const own = readScope(agentConfigOf(config, type), "skills");
  if (own !== undefined) return own;
  const inherited = readScope(config.agents?.orchestrator, "skills");
  return inherited ?? "all";
}

export function resolveAgentMcp(config: MyClawConfig, type: AgentToolType): AgentScope {
  const own = readScope(agentConfigOf(config, type), "mcp");
  if (own !== undefined) return own;
  // The one override of the inheritance rule: the research agent got zero MCP tools before this
  // existed, so inheriting the orchestrator's list would hand it every server on upgrade -- a
  // widening nobody asked for, disguised as a default. Only an explicit list grants it servers.
  if (type === "research") return [];
  const inherited = readScope(config.agents?.orchestrator, "mcp");
  return inherited ?? "all";
}

export function scopeAllows(scope: AgentScope, name: string): boolean {
  return scope === "all" || scope.includes(name);
}

/**
 * The workspace key an agent type runs in, or undefined for the default workspace. Unlike skills
 * and mcp there is no inheritance from the orchestrator: pinning the main agent to a project must
 * not silently drag every sub-agent and cron job into it.
 */
export function resolveAgentWorkspace(config: MyClawConfig, type: AgentToolType, fileWorkspace?: string): string | undefined {
  const key = agentConfigOf(config, type)?.workspace ?? fileWorkspace;
  return key ? key : undefined;
}

/**
 * Reverse lookup: the key of the workspace a directory belongs to, or undefined for the default
 * one. Used where only the resolved directory travels (tool args, sub-agent inheritance) and the
 * key is needed to scope skills.
 */
export function workspaceKeyForDir(config: MyClawConfig, dir: string | undefined): string | undefined {
  if (!dir || dir === resolveWorkspaceDir(config.workspace)) return undefined;
  for (const [key, root] of Object.entries(config.workspaces ?? {})) {
    if (dir === root) return key;
  }
  return undefined;
}

/** Agent entries pointing at a workspace key that does not exist. Reported at boot like an
 *  unknown scope entry: a typo would otherwise pin an agent to nothing and fail at run time. */
export function findUnknownAgentWorkspaces(config: MyClawConfig): Array<{ path: string; key: string }> {
  const out: Array<{ path: string; key: string }> = [];
  for (const agentKey of configuredAgentKeys(config)) {
    const key = agentConfigOf(config, agentKey)?.workspace;
    if (!key) continue;
    if (!config.workspaces?.[key]) out.push({ path: `agents.${agentKey}.workspace`, key });
  }
  return out;
}

/**
 * The agent sections the owner actually wrote, `nested` excluded. Iterating this rather than the
 * reserved roles is what makes the boot checks cover file-defined agents: a typo under
 * `agents.reviewer` used to be invisible because `reviewer` was not one of the four known keys.
 */
export function configuredAgentKeys(config: MyClawConfig): string[] {
  return Object.keys(config.agents ?? {}).filter((key) => key !== "nested");
}

/**
 * Config sections addressing an agent that does not exist: neither a reserved role nor a file in
 * `agents/`. Reported at boot for the same reason as an unknown scope entry -- the section is read
 * by nothing, so the setting silently does not apply. See docs/file-agents.md.
 */
export function findUnknownAgents(config: MyClawConfig, knownAgents: readonly string[]): string[] {
  const known = new Set<string>([...AGENT_KEYS, ...knownAgents]);
  return configuredAgentKeys(config).filter((key) => !known.has(key));
}

export interface UnknownScopeEntry {
  /** Config path as the owner wrote it, e.g. `agents.general.skills`. */
  path: string;
  name: string;
  kind: "skill" | "mcp";
}

/**
 * Scope entries that match no installed skill and no declared MCP server. A typo silently narrows an
 * agent's world, and the symptom is an agent that quietly stops using a skill, so this is reported
 * at boot rather than waiting for someone to run `/skills`.
 *
 * A report, never a refusal: a renamed skill must not take the process down.
 */
export function findUnknownScopeEntries(
  config: MyClawConfig,
  known: { skills: readonly string[]; mcpServers: readonly string[] },
): UnknownScopeEntry[] {
  const out: UnknownScopeEntry[] = [];
  // cron is absent on purpose: its scope is resolved through resolveAgentSkills/Mcp like any
  // agent's, but the boot report predates the cron key and nothing changed since.
  for (const key of configuredAgentKeys(config).filter((k) => k !== "cron")) {
    const agent = agentConfigOf(config, key);
    if (!agent) continue;
    for (const [field, kind, pool] of [
      ["skills", "skill", known.skills],
      ["mcp", "mcp", known.mcpServers],
    ] as const) {
      const list = agent[field];
      // The wildcard entry is not a name, and "all" carries nothing to validate.
      if (!Array.isArray(list) || list.includes(SCOPE_WILDCARD)) continue;
      for (const name of list) {
        if (!pool.includes(name)) out.push({ path: `agents.${key}.${field}`, name, kind });
      }
    }
  }
  return out;
}

// MY_CLAW_DIR env override exists so tests (and alternate deployments) never touch
// the real ~/.my-claw. The test preload (bunfig.toml) points it at a temp dir.
export const MY_CLAW_DIR = process.env["MY_CLAW_DIR"] ?? join(homedir(), ".my-claw");

/**
 * Load ~/.my-claw/.env into process.env.
 *
 * At boot (forceRefresh=false) the shell/systemd environment wins: a key already
 * present is left alone. On hot-reload (forceRefresh=true) the file becomes
 * authoritative so an edited secret overwrites the stale in-memory value —
 * without this, a rotated token would survive until the next process restart.
 * Only secrets read fresh per run (CLAUDE_CODE_OAUTH_TOKEN, consumed by the
 * Claude SDK backend which rebuilds env + respawns the CLI every run) take
 * effect immediately.
 */
export async function loadEnv(forceRefresh = false): Promise<void> {
  const envPath = join(MY_CLAW_DIR, ".env");
  try {
    const text = await readFile(envPath, "utf-8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim();
      if (key && value && (forceRefresh || process.env[key] === undefined)) {
        process.env[key] = value;
      }
    }
  } catch {
    // .env absent; continue with existing env.
  }
}

function applySecretOverrides(config: MyClawConfig): void {
  if (config.webSearch && process.env.MY_CLAW_WEB_SEARCH_TOKEN) {
    config.webSearch.token = process.env.MY_CLAW_WEB_SEARCH_TOKEN;
  }
}

export function isMyClawAppChannelEnabled(config: MyClawConfig): boolean {
  return config.channels["my-claw-app"]?.enabled !== false && Boolean(config.channels["my-claw-app"]);
}

/** Files seeded into a fresh default workspace: the four prompt files, plus the two that exist for
 *  the owner's benefit and are read by no line of src/ (SYSTEM.md, MEMORY.md). */
const PROMPT_TEMPLATES = [...PROMPT_FILES, "SYSTEM.md", "MEMORY.md"] as const;

export async function seedWorkspaceTemplates(workspacePath: string): Promise<void> {
  const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
  const templateDir = join(repoRoot, "docs", "prompt");
  for (const name of PROMPT_TEMPLATES) {
    const dest = join(workspacePath, name);
    try {
      await access(dest);
    } catch {
      try {
        await copyFile(join(templateDir, name), dest);
      } catch {
        // Template source missing; leave destination empty.
      }
    }
  }
}

function isLegacyLlmConfig(llm: unknown): boolean {
  if (!llm || typeof llm !== "object") return false;
  const cast = llm as Record<string, unknown>;
  return cast.providers === undefined && (cast.baseUrl !== undefined || cast.model !== undefined);
}

function migrateLegacyLlmConfig(llm: Record<string, unknown>): LlmConfig {
  const baseUrl = typeof llm.baseUrl === "string" ? llm.baseUrl : "";
  const model = typeof llm.model === "string" ? llm.model : "";
  const providerName = typeof llm.provider === "string" ? llm.provider : "default";

  const migrated: LlmConfig = {
    defaultProvider: providerName,
    defaultModel: model,
    apiKey: typeof llm.apiKey === "string" ? llm.apiKey : undefined,
    vision: typeof llm.vision === "boolean" ? llm.vision : undefined,
    limit: llm.limit && typeof llm.limit === "object" ? llm.limit as LlmConfig["limit"] : undefined,
    providers: {
      [providerName]: {
        baseUrl: baseUrl || "https://api.fireworks.ai/inference/v1",
      },
    },
    models: Array.isArray(llm.models)
      ? llm.models.map((m: unknown) => {
        if (!m || typeof m !== "object") return { id: "", label: "" };
        const cast = m as Record<string, unknown>;
        return {
          id: typeof cast.id === "string" ? cast.id : "",
          label: typeof cast.label === "string" ? cast.label : "",
          provider: providerName,
          limit: cast.limit && typeof cast.limit === "object" ? cast.limit as LlmConfig["limit"] : undefined,
        };
      }).filter((m) => m.id)
      : [],
  };

  return migrated;
}

function migrateLegacyAgentLlmConfig(agentLlm: unknown): AgentLlmConfig {
  if (!agentLlm || typeof agentLlm !== "object") {
    throw new Error("Invalid agent LLM config");
  }
  const cast = agentLlm as Record<string, unknown>;
  return {
    defaultProvider: typeof cast.provider === "string" ? cast.provider : undefined,
    defaultModel: typeof cast.model === "string" ? cast.model : undefined,
  };
}

export const CONFIG_PATH = join(MY_CLAW_DIR, "config.json");

/**
 * Sections the hot-reload watcher mutates in place. Declared here rather than in config-watcher.ts
 * so the structural guard below can share the exact same lists instead of drifting from them.
 */
export const HOT_OBJECT_SECTIONS = [
  "llm", "agents", "injection", "browser", "webSearch", "context", "tools", "skills", "mcp", "voice", "cron", "memory", "workspaces", "workspacePrompts", "tags", "uiPrefs",
] as const;
/** Array sections whose identity must be preserved (consumers hold the same array reference). */
export const HOT_ARRAY_SECTIONS = ["whitelist", "blacklist"] as const;

/**
 * Reject a config that would corrupt live state, without constraining what it may contain.
 *
 * Deliberately not a schema. A missing section stays legal: `applyObjectSection` empties the live
 * section, which is what a restart produces too (no override, defaults apply). The only class this
 * catches is a section of the wrong *type* -- `"llm": "oops"` gets stored as-is and breaks the
 * object identity that every hot-reload consumer depends on.
 */
function assertStructure(config: MyClawConfig): void {
  const rec = config as unknown as Record<string, unknown>;
  for (const key of HOT_OBJECT_SECTIONS) {
    const v = rec[key];
    if (v === undefined || v === null) continue;
    if (typeof v !== "object" || Array.isArray(v)) {
      throw new Error(`Invalid config: "${key}" must be an object, got ${Array.isArray(v) ? "array" : typeof v}`);
    }
  }
  for (const key of HOT_ARRAY_SECTIONS) {
    const v = rec[key];
    if (v === undefined || v === null) continue;
    if (!Array.isArray(v)) throw new Error(`Invalid config: "${key}" must be an array, got ${typeof v}`);
  }
  if (config.channels !== undefined && (typeof config.channels !== "object" || Array.isArray(config.channels))) {
    throw new Error(`Invalid config: "channels" must be an object`);
  }
}

/**
 * Parse raw JSON config text into a normalized MyClawConfig.
 * Runs legacy migrations, applies defaults, and overlays env secrets.
 * Pure with respect to the filesystem (no mkdir/seed) so it is reusable for hot-reload.
 * Throws on invalid JSON or a structurally unusable section.
 */
export function parseConfig(raw: string): MyClawConfig {
  let config: MyClawConfig;
  try {
    config = JSON.parse(raw) as MyClawConfig;
  } catch (err) {
    throw new Error(
      `Invalid JSON in ${CONFIG_PATH}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    throw new Error(`Invalid config: ${CONFIG_PATH} must contain a JSON object`);
  }
  assertStructure(config);
  validateWorkspaces(config);
  validateWorkspacePrompts(config);

  if (isLegacyLlmConfig(config.llm)) {
    config.llm = migrateLegacyLlmConfig(config.llm as Record<string, unknown>);
  }
  // Every agent key, not just the two that had a working model override: `orchestrator` was skipped
  // here for as long as its model was dead config, so a legacy `{"model": ...}` under it stayed
  // legacy and would now resolve to nothing.
  for (const key of AGENT_KEYS) {
    const agent = config.agents?.[key];
    if (agent?.llm && isLegacyLlmConfig(agent.llm)) {
      agent.llm = migrateLegacyAgentLlmConfig(agent.llm);
    }
  }

  config.whitelist = config.whitelist ?? [];
  config.blacklist = config.blacklist ?? [];
  // A config.json without "channels" used to reach the channel readers and die with an opaque
  // "undefined is not an object". The type says the key is required, which is exactly why
  // nothing checked it.
  config.channels = config.channels ?? {};
  applySecretOverrides(config);
  return config;
}

/**
 * Re-read config.json from disk and parse it, without any workspace side effects.
 * Used by the hot-reload watcher. Force-refreshes loadEnv so a rotated secret in
 * .env overwrites the stale in-memory value instead of surviving until restart.
 */
export async function readConfigFromDisk(): Promise<MyClawConfig> {
  await loadEnv(true);
  const raw = await readFile(CONFIG_PATH, "utf-8");
  return parseConfig(raw);
}

/** Effective workspace directory for a raw config value. Boot rewrites config.workspace to
 *  this resolved path, so anything comparing a live config against the file on disk has to
 *  normalize both sides or it sees a change that never happened. */
export function resolveWorkspaceDir(raw?: string): string {
  return raw ?? join(MY_CLAW_DIR, "workspace");
}

/**
 * Resolve a workspace key against the named list, or the default workspace when absent.
 * A key that no longer exists resolves to the default workspace too: a removed workspace must
 * not take the runs that referenced it down. The staleness stays visible -- the app flags it
 * red, and boot still reports it -- but the resolution itself never throws.
 */
export function resolveWorkspaceKey(config: MyClawConfig, key?: string): string {
  if (!key) return resolveWorkspaceDir(config.workspace);
  const dir = config.workspaces?.[key];
  if (typeof dir === "string") return dir;
  // Unknown or removed key: the safest directory is the one every unkeyed run already uses.
  return resolveWorkspaceDir(config.workspace);
}

/**
 * A workspace list with a relative path or a reserved key would silently point runs at the
 * wrong directory later: refuse the config as a whole, like any other structural violation.
 * Throws in parseConfig, so boot and hot-reload reject it the same way.
 */
function validateWorkspaces(config: MyClawConfig): void {
  const workspaces = config.workspaces;
  if (workspaces === undefined) return;
  if (typeof workspaces !== "object" || Array.isArray(workspaces)) {
    throw new Error('Invalid config: "workspaces" must be an object mapping names to absolute paths');
  }
  for (const [key, dir] of Object.entries(workspaces)) {
    if (!key || key === "default" || key.includes("/")) {
      throw new Error(`Invalid config: "workspaces.${key}" — the key "default" is reserved and keys cannot contain "/"`);
    }
    if (typeof dir !== "string" || !dir.startsWith("/")) {
      throw new Error(`Invalid config: "workspaces.${key}" must be an absolute path, got "${String(dir)}"`);
    }
  }
}

/** Structural checks for workspacePrompts; a wrong type or an unknown file name would otherwise
 *  be silently read as "no policy". Orphan workspace keys are a boot report, not a parse error:
 *  a workspace can be removed after its policy was written, and that must not stop the boot. */
function validateWorkspacePrompts(config: MyClawConfig): void {
  const section = config.workspacePrompts;
  if (section === undefined) return;
  if (typeof section !== "object" || Array.isArray(section)) {
    throw new Error('Invalid config: "workspacePrompts" must be an object keyed by workspace');
  }
  for (const [workspaceKey, files] of Object.entries(section)) {
    if (typeof files !== "object" || files === null || Array.isArray(files)) {
      throw new Error(`Invalid config: "workspacePrompts.${workspaceKey}" must be an object`);
    }
    for (const [file, filePolicy] of Object.entries(files)) {
      if (!(PROMPT_FILES as readonly string[]).includes(file)) {
        throw new Error(`Invalid config: "workspacePrompts.${workspaceKey}.${file}" is not a prompt file`);
      }
      if (typeof filePolicy !== "object" || filePolicy === null || Array.isArray(filePolicy)) {
        throw new Error(`Invalid config: "workspacePrompts.${workspaceKey}.${file}" must be an object`);
      }
      if (filePolicy.inherit !== undefined && (typeof filePolicy.inherit !== "string" || filePolicy.inherit.trim() === "")) {
        throw new Error(`Invalid config: "workspacePrompts.${workspaceKey}.${file}.inherit" must be a non-empty string`);
      }
      if (filePolicy.off !== undefined && typeof filePolicy.off !== "boolean") {
        throw new Error(`Invalid config: "workspacePrompts.${workspaceKey}.${file}.off" must be a boolean`);
      }
    }
  }
}

/** Where a workspace reads a prompt file it does not own. `builtin` is the shipped template,
 *  `none` ends the ladder; any other value is a config.workspaces key. */
export type PromptSource = string;

export interface PromptFilePolicy {
  /** The source for this file. Absent means "default", the pre-existing behavior. */
  inherit?: PromptSource;
  /** Drops the layer even when this workspace owns the file. */
  off?: boolean;
}

/** Per-file prompt policy of one workspace, keyed directly by prompt file name. */
export type WorkspacePromptPolicy = Partial<Record<PromptFile, PromptFilePolicy>>;

/**
 * The effective policy for one (workspace, file), normalised: absent means inherit from the
 * default workspace with the layer on. Values are validated at parse time, so the only cleanup
 * here is the default.
 */
export function resolvePromptPolicy(
  workspacePrompts: Record<string, WorkspacePromptPolicy> | undefined,
  workspaceKey: string | undefined,
  file: string,
): Required<PromptFilePolicy> {
  const policy = workspacePrompts?.[workspaceKey ?? ""]?.[file as PromptFile];
  return { inherit: policy?.inherit ?? "default", off: policy?.off ?? false };
}

/**
 * Prompt policies addressing a workspace that does not exist. Reported at boot like an unknown
 * agent workspace: an orphan policy is read by no run, and the failure would otherwise only
 * surface as a missing layer on the first run that expected it.
 */
export function findUnknownPromptWorkspaces(config: MyClawConfig): Array<{ key: string }> {
  return Object.keys(config.workspacePrompts ?? {})
    .filter((key) => key !== "default" && !config.workspaces?.[key])
    .map((key) => ({ key }));
}

/** Workspace keys that shadow a prompt source keyword: `inherit: "none"` in a policy would read
 *  that workspace's files instead of nothing. Not fatal -- a declared key wins -- but the owner
 *  should know a policy keyword can never select that workspace. */
export function findShadowingWorkspaceKeys(config: MyClawConfig): string[] {
  return Object.keys(config.workspaces ?? {}).filter((key) => key === "builtin" || key === "none");
}

/**
 * Filesystem side effects a parsed config needs before use: resolve and create the workspace, seed
 * the prompt templates. Split out of loadConfig so the boot fallback can run them on a config that
 * came from a snapshot rather than from CONFIG_PATH.
 */
export async function finalizeConfig(config: MyClawConfig): Promise<MyClawConfig> {
  const workspacePath = resolveWorkspaceDir(config.workspace);
  await mkdir(workspacePath, { recursive: true });
  await seedWorkspaceTemplates(workspacePath);
  config.workspace = workspacePath;
  for (const dir of Object.values(config.workspaces ?? {})) {
    await mkdir(dir, { recursive: true });
  }
  return config;
}

export async function loadConfig(): Promise<MyClawConfig> {
  await mkdir(MY_CLAW_DIR, { recursive: true });
  await loadEnv();
  let raw: string;
  try {
    raw = await readFile(CONFIG_PATH, "utf-8");
  } catch {
    throw new Error(
      `Config file not found at ${CONFIG_PATH}\nCopy the template: cp packaging/config.json ~/.my-claw/config.json`,
    );
  }
  return finalizeConfig(parseConfig(raw));
}
