import { readFile, mkdir, copyFile, access } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

export interface TelegramChannelConfig {
  enabled?: boolean;
  token: string;
  mode?: "polling" | "webhook";
  dm?: {
    enabled?: boolean;
    policy?: "open" | "allowlist" | "disabled";
    allowFrom?: string[];
    sessionScope?: "per-user" | "per-chat";
  };
  groupPolicy?: "open" | "allowlist" | "disabled";
  groupAllowFrom?: string[];
  botUserIds?: string[];
  allowBots?: boolean | "mentions";
  groups?: Record<
    string,
    {
      enabled?: boolean;
      requireMention?: boolean;
      users?: string[];
      autoReply?: boolean;
      allowBots?: boolean | "mentions";
    }
  >;
  threadReplies?: "off" | "inbound" | "always";
  replyToMode?: "off" | "first" | "all";
  historyLimit?: number;
  contextVisibility?: "all" | "allowlist" | "allowlist_quote";
  webhook?: {
    url: string;
    secret: string;
    port: number;
  };
  linkPreview?: boolean;
  streaming?: {
    enabled?: boolean;
    minChars?: number;
    throttleMs?: number;
  };
  reactions?: {
    enabled?: boolean;
    received?: string;
    thinking?: string;
    toolUse?: string;
    done?: string;
    error?: string;
  };
  errorPolicy?: "always" | "once" | "silent";
}

export interface MatrixChannelConfig {
  enabled?: boolean;
  homeserver: string;
  accessToken: string;
  encryption?: boolean;
  userId?: string;
  password?: string;
  deviceId?: string;
  displayName?: string;
  initialSyncLimit?: number;
  autoJoin?: "off" | "always" | "allowlist";
  autoJoinAllowlist?: string[];
  dm?: {
    enabled?: boolean;
    policy?: "open" | "allowlist" | "disabled";
    allowFrom?: string[];
    sessionScope?: "per-user" | "per-room";
    threadReplies?: "off" | "inbound" | "always";
    historyLimit?: number;
  };
  groupPolicy?: "open" | "allowlist" | "disabled";
  groupAllowFrom?: string[];
  botUserIds?: string[];
  allowBots?: boolean | "mentions";
  groups?: Record<
    string,
    {
      enabled?: boolean;
      requireMention?: boolean;
      users?: string[];
      autoReply?: boolean;
      allowBots?: boolean | "mentions";
    }
  >;
  threadReplies?: "off" | "inbound" | "always";
  replyToMode?: "off" | "first" | "all" | "batched";
  historyLimit?: number;
  textChunkLimit?: number;
  chunkMode?: "length" | "newline";
  contextVisibility?: "all" | "allowlist" | "allowlist_quote";
  streaming?: {
    enabled?: boolean;
    mode?: "partial" | "quiet";
    minChars?: number;
    throttleMs?: number;
  };
  reactions?: {
    enabled?: boolean;
    received?: string;
    thinking?: string;
    toolUse?: string;
    done?: string;
    error?: string;
  };
  errorPolicy?: "always" | "once" | "silent";
  mediaMaxMb?: number;
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
  // "claude-sdk" = runs delegated to the Claude Agent SDK (subscription auth, own loop).
  // "codex" = OpenAI ChatGPT subscription via the Responses backend (device-code OAuth,
  // home loop with the Codex transport). See docs/claude-sdk-backend.md and docs/codex-backend.md.
  type?: "openai" | "claude-sdk" | "codex";
  baseUrl?: string;
  apiKeyEnv?: string;
  headers?: Record<string, string>;
  // claude-sdk only: automatic failover model if the primary errors out.
  fallbackModel?: string;
  // Auto-discover this provider's models at runtime (claude-sdk: query.supportedModels();
  // openai-compatible: GET {baseUrl}/models). Discovered models merge with config.models
  // (config wins on id collision). See docs/model-discovery.md.
  discover?: boolean;
  // Submenu group label applied to this provider's discovered models in the picker.
  group?: string;
  // OpenAI-compatible providers only: send Anthropic-style `cache_control` breakpoints so
  // proxies that support it (LiteLLM, OpenRouter) cache the stable system+tools prefix.
  // Opt-in per provider: some strict endpoints reject unknown fields in message content.
  // Ignored on the claude-sdk (SDK caches itself) and codex (subscription) backends.
  // See docs/prompt-caching.md.
  promptCache?: boolean;
}

// Reasoning/thinking effort. Native on the Claude Agent SDK (query `effort`); sent as
// `reasoning_effort` to OpenAI-compatible providers only when the model opts in via
// `supportsEffort` (avoids 400s on providers that reject the param).
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

export interface LlmModelConfig {
  id: string;
  label: string;
  provider?: string;
  // Optional submenu grouping for the model picker: models sharing a `group` value are
  // collapsed behind a single "<group> >" entry in /model. A "/"-separated value nests
  // submenus (e.g. "Claude/Opus"). Ungrouped models stay at root.
  group?: string;
  // Per-model default effort (overrides the global llm.effort). Session /effort wins over both.
  effort?: EffortLevel;
  // OpenAI-compatible models only: opt in to forwarding `reasoning_effort`. Ignored for
  // claude-sdk models (they always accept effort natively).
  supportsEffort?: boolean;
  // Per-model supported effort levels (SDK discovery provides these). When set, the effort
  // submenu only shows these levels instead of the full global list.
  supportedEffortLevels?: EffortLevel[];
  vision?: boolean;
  limit?: {
    context?: number;
    output?: number;
  };
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
}

export interface ResolvedLlmConfig {
  // Which agent engine runs this model. Absent = "openai" (home loop). The dispatcher
  // routes on this before any HTTP/SDK specifics come into play. "codex" runs on the home
  // loop too, but the loop swaps in the Codex Responses transport (see docs/codex-backend.md).
  backend?: "openai" | "claude-sdk" | "codex";
  baseUrl: string;
  model: string;
  apiKey?: string;
  headers?: Record<string, string>;
  vision?: boolean;
  limit?: {
    context?: number;
    output?: number;
  };
  fallbackModel?: string;
  // Resolved effort to apply for this run. Only set when it should actually be sent
  // (claude-sdk always; openai-compatible only when the model opts in via supportsEffort).
  effort?: EffortLevel;
  // Send Anthropic-style `cache_control` breakpoints on the OpenAI-compatible request
  // (propagated from the provider's `promptCache`). See docs/prompt-caching.md.
  promptCache?: boolean;
}

export interface AgentLlmConfig {
  defaultProvider?: string;
  defaultModel?: string;
}

export interface AgentConfig {
  maxIterations?: number;
  llm?: AgentLlmConfig;
  /**
   * Skill names this agent may see and read. Exact names, or the single entry `["*"]` for all.
   * Absent inherits the orchestrator's list; absent there too means all. See docs/agent-scoping.md.
   */
  skills?: string[];
  /** MCP server names whose tools reach this agent. Same semantics as `skills`. */
  mcp?: string[];
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
    telegram?: TelegramChannelConfig;
    matrix?: MatrixChannelConfig;
  };
  llm: LlmConfig;
  agents: {
    orchestrator?: AgentConfig;
    general?: AgentConfig;
    research?: AgentConfig;
    nested?: NestedAgentsConfig;
  };
  voice?: VoiceConfig;
  webSearch?: WebSearchConfig;
  browser?: BrowserConfig;
  workspace?: string;
  cron?: CronConfig;
  memory?: MemoryConfig;
  injection?: InjectionConfig;
  antiInjection?: AntiInjectionConfig;
  context?: ContextConfig;
  tools?: ToolsConfig;
  skills?: SkillsConfig;
  mcp?: Record<string, McpServerConfig>;
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
}

export interface ContextPruningConfig {
  enabled?: boolean; // default true
  keepLastAssistantTurns?: number; // tool results inside this window are never pruned (default 5)
  headChars?: number; // chars of the original output kept in the stub (default 200)
}

export interface AutoCompactConfig {
  enabled?: boolean; // default true
  thresholdRatio?: number; // fraction of the context limit that triggers compaction (default 0.8)
}

export const DEFAULT_PRUNING_KEEP_TURNS = 5;
export const DEFAULT_PRUNING_HEAD_CHARS = 200;
export const DEFAULT_AUTO_COMPACT_THRESHOLD = 0.8;

export function contextPruningEnabled(config: MyClawConfig): boolean {
  return config.context?.pruning?.enabled !== false;
}

export function resolveContextPruning(config: MyClawConfig): { keepLastAssistantTurns: number; headChars: number } {
  const p = config.context?.pruning;
  const turns = p?.keepLastAssistantTurns;
  const head = p?.headChars;
  return {
    keepLastAssistantTurns: typeof turns === "number" && Number.isFinite(turns) && turns > 0 ? Math.floor(turns) : DEFAULT_PRUNING_KEEP_TURNS,
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

/**
 * Anti-injection scan of the user turn. Named apart from `injection` above, which is the unrelated
 * mid-run steering feature. Governs the user turn only: foreign content (tool results, fetched
 * pages, nested AGENTS.md) is always scanned and always blocked so an editable file can never
 * weaken the guard. See `docs/anti-injection.md`.
 */
export interface AntiInjectionConfig {
  enabled?: boolean; // default true
  ownerSanction?: "annotate" | "block"; // default "annotate"
}

/** Resolved per run and passed explicitly; the preprocessor holds no config of its own. */
export interface ScanPolicy {
  enabled: boolean;
  ownerSanction: "annotate" | "block";
}

export function resolveScanPolicy(config: MyClawConfig | undefined): ScanPolicy {
  return {
    enabled: config?.antiInjection?.enabled !== false,
    ownerSanction: config?.antiInjection?.ownerSanction === "block" ? "block" : "annotate",
  };
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

export function resolveMaxIterations(config: MyClawConfig, type: "orchestrator" | "general" | "research"): number {
  const agentCfg = config.agents?.[type];
  if (agentCfg?.maxIterations !== undefined && Number.isFinite(agentCfg.maxIterations) && agentCfg.maxIterations > 0) {
    return agentCfg.maxIterations;
  }
  return type === "orchestrator" ? DEFAULT_ORCHESTRATOR_MAX_ITERATIONS : DEFAULT_SUBAGENT_MAX_ITERATIONS;
}

/**
 * Agent scoping. Two vocabularies exist for agents: the tool axis is
 * `main | general | research | cron` and the config axis is `orchestrator | general | research`.
 * `main` and `orchestrator` are the same agent, and `cron` has no config entry of its own.
 * Callers pass the tool-axis value; the mapping below is the single place they meet.
 * See docs/agent-scoping.md.
 */
export type AgentToolType = "main" | "general" | "research" | "cron";

/** `"all"` is a distinct value, not a sentinel array, so it cannot be mistaken for a list. */
export type AgentScope = string[] | "all";

const SCOPE_WILDCARD = "*";

function configKeyForAgent(type: AgentToolType): "orchestrator" | "general" | "research" {
  // cron inherits the orchestrator: that is today's behavior, and a fourth config key would carry a
  // name that exists on neither axis.
  if (type === "general" || type === "research") return type;
  return "orchestrator";
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

export function resolveAgentSkills(config: MyClawConfig, type: AgentToolType): AgentScope {
  const own = readScope(config.agents?.[configKeyForAgent(type)], "skills");
  if (own !== undefined) return own;
  const inherited = readScope(config.agents?.orchestrator, "skills");
  return inherited ?? "all";
}

export function resolveAgentMcp(config: MyClawConfig, type: AgentToolType): AgentScope {
  const own = readScope(config.agents?.[configKeyForAgent(type)], "mcp");
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
  for (const key of ["orchestrator", "general", "research"] as const) {
    const agent = config.agents?.[key];
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
 * effect immediately; channel tokens update process.env but the live Telegram/
 * Matrix client keeps its old connection until reboot.
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
  const tg = config.channels.telegram;
  if (tg && process.env.MY_CLAW_TELEGRAM_TOKEN) {
    tg.token = process.env.MY_CLAW_TELEGRAM_TOKEN;
  }

  const mx = config.channels.matrix;
  if (mx) {
    if (process.env.MY_CLAW_MATRIX_ACCESS_TOKEN) {
      mx.accessToken = process.env.MY_CLAW_MATRIX_ACCESS_TOKEN;
    }
    if (process.env.MY_CLAW_MATRIX_PASSWORD) {
      mx.password = process.env.MY_CLAW_MATRIX_PASSWORD;
    }
  }

  if (config.webSearch && process.env.MY_CLAW_WEB_SEARCH_TOKEN) {
    config.webSearch.token = process.env.MY_CLAW_WEB_SEARCH_TOKEN;
  }
}

export function isTelegramChannelEnabled(config: MyClawConfig): boolean {
  return config.channels.telegram?.enabled !== false && Boolean(config.channels.telegram);
}

export function isMatrixChannelEnabled(config: MyClawConfig): boolean {
  return config.channels.matrix?.enabled !== false && Boolean(config.channels.matrix);
}

const PROMPT_TEMPLATES = ["SYSTEM.md", "CORE.md", "SOUL.md", "AGENTS.md", "USER.md", "MEMORY.md"] as const;

async function seedWorkspaceTemplates(workspacePath: string): Promise<void> {
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
  "llm", "agents", "injection", "antiInjection", "browser", "webSearch", "context", "tools", "skills", "mcp", "voice", "cron", "memory",
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

  if (isLegacyLlmConfig(config.llm)) {
    config.llm = migrateLegacyLlmConfig(config.llm as Record<string, unknown>);
  }
  if (config.agents?.general?.llm && isLegacyLlmConfig(config.agents.general.llm)) {
    config.agents.general.llm = migrateLegacyAgentLlmConfig(config.agents.general.llm);
  }
  if (config.agents?.research?.llm && isLegacyLlmConfig(config.agents.research.llm)) {
    config.agents.research.llm = migrateLegacyAgentLlmConfig(config.agents.research.llm);
  }

  config.whitelist = config.whitelist ?? [];
  config.blacklist = config.blacklist ?? [];
  // A config.json without "channels" used to reach applySecretOverrides and die on
  // `config.channels.telegram` with an opaque "undefined is not an object". The type says the key
  // is required, which is exactly why nothing checked it.
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
 * Filesystem side effects a parsed config needs before use: resolve and create the workspace, seed
 * the prompt templates. Split out of loadConfig so the boot fallback can run them on a config that
 * came from a snapshot rather than from CONFIG_PATH.
 */
export async function finalizeConfig(config: MyClawConfig): Promise<MyClawConfig> {
  const workspacePath = resolveWorkspaceDir(config.workspace);
  await mkdir(workspacePath, { recursive: true });
  await seedWorkspaceTemplates(workspacePath);
  config.workspace = workspacePath;
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
