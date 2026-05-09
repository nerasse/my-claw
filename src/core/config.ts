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
}

export interface VoiceConfig {
  mode?: "cloud" | "local" | "auto";
  stt?: VoiceSttConfig;
  tts?: VoiceTtsConfig;
}

export interface MyClawConfig {
  whitelist: string[];
  blacklist: string[];
  channels: {
    telegram?: TelegramChannelConfig;
    matrix?: MatrixChannelConfig;
  };
  llm: {
    provider: string;
    baseUrl: string;
    model: string;
    apiKey?: string;
    vision?: boolean;
    limit?: {
      context?: number;
      output?: number;
    };
    models?: Array<{
      id: string;
      label: string;
      limit?: {
        context?: number;
        output?: number;
      };
    }>;
  };
  agents: {
    general?: { llm?: MyClawConfig["llm"] };
    research?: { llm?: MyClawConfig["llm"] };
  };
  voice?: VoiceConfig;
  workspace?: string;
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

  if (config.llm) {
    const fireworksKey = process.env.MY_CLAW_FIREWORKS_API_KEY ?? process.env.FIREWORKS_API_KEY;
    if (fireworksKey) {
      config.llm.apiKey = fireworksKey;
    }
  }
}

export function isTelegramChannelEnabled(config: MyClawConfig): boolean {
  return config.channels.telegram?.enabled !== false && Boolean(config.channels.telegram);
}

export function isMatrixChannelEnabled(config: MyClawConfig): boolean {
  return config.channels.matrix?.enabled !== false && Boolean(config.channels.matrix);
}

const PROMPT_TEMPLATES = ["SOUL.md", "AGENTS.md", "USER.md", "MEMORY.md"] as const;

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

export async function loadConfig(): Promise<MyClawConfig> {
  await mkdir(MY_CLAW_DIR, { recursive: true });
  await loadEnv();
  const configPath = join(MY_CLAW_DIR, "config.json");
  const raw = await readFile(configPath, "utf-8");
  const config = JSON.parse(raw) as MyClawConfig;
  applySecretOverrides(config);
  const workspacePath = config.workspace ?? join(MY_CLAW_DIR, "workspace");
  await mkdir(workspacePath, { recursive: true });
  await seedWorkspaceTemplates(workspacePath);
  config.workspace = workspacePath;
  return config;
}
