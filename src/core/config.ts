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
  cdpUrl?: string;
  novncUrl?: string;
  viewport?: { width: number; height: number };
  maxSteps?: number;
  idleTimeoutMs?: number;
}

export interface LlmProviderConfig {
  baseUrl: string;
  apiKeyEnv?: string;
  headers?: Record<string, string>;
}

export interface LlmModelConfig {
  id: string;
  label: string;
  provider?: string;
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

  defaultProvider?: string;
  defaultModel?: string;
  providers?: Record<string, LlmProviderConfig>;
}

export interface ResolvedLlmConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
  headers?: Record<string, string>;
  vision?: boolean;
  limit?: {
    context?: number;
    output?: number;
  };
}

export interface AgentLlmConfig {
  defaultProvider?: string;
  defaultModel?: string;
}

export interface AgentConfig {
  maxIterations?: number;
  llm?: AgentLlmConfig;
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
  };
  voice?: VoiceConfig;
  webSearch?: WebSearchConfig;
  browser?: BrowserConfig;
  workspace?: string;
  cron?: CronConfig;
  memory?: MemoryConfig;
  injection?: InjectionConfig;
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

export function resolveMaxIterations(config: MyClawConfig, type: "orchestrator" | "general" | "research"): number {
  const agentCfg = config.agents?.[type];
  if (agentCfg?.maxIterations !== undefined && Number.isFinite(agentCfg.maxIterations) && agentCfg.maxIterations > 0) {
    return agentCfg.maxIterations;
  }
  return type === "orchestrator" ? DEFAULT_ORCHESTRATOR_MAX_ITERATIONS : DEFAULT_SUBAGENT_MAX_ITERATIONS;
}

export const MY_CLAW_DIR = join(homedir(), ".my-claw");

async function loadEnv(): Promise<void> {
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
      if (key && value && process.env[key] === undefined) {
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

const PROMPT_TEMPLATES = ["SYSTEM.md", "SOUL.md", "AGENTS.md", "USER.md", "MEMORY.md"] as const;

async function seedWorkspaceTemplates(workspacePath: string): Promise<void> {
  const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
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
 * Parse raw JSON config text into a normalized MyClawConfig.
 * Runs legacy migrations, applies defaults, and overlays env secrets.
 * Pure with respect to the filesystem (no mkdir/seed) so it is reusable for hot-reload.
 * Throws on invalid JSON.
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
  applySecretOverrides(config);
  return config;
}

/**
 * Re-read config.json from disk and parse it, without any workspace side effects.
 * Used by the hot-reload watcher. Re-runs loadEnv so newly added secrets are picked up.
 */
export async function readConfigFromDisk(): Promise<MyClawConfig> {
  await loadEnv();
  const raw = await readFile(CONFIG_PATH, "utf-8");
  return parseConfig(raw);
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
  const config = parseConfig(raw);
  const workspacePath = config.workspace ?? join(MY_CLAW_DIR, "workspace");
  await mkdir(workspacePath, { recursive: true });
  await seedWorkspaceTemplates(workspacePath);
  config.workspace = workspacePath;
  return config;
}
