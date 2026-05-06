import { readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

export interface TelegramChannelConfig {
  token: string;
  mode?: "polling" | "webhook";
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
  userId?: string;
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
    models?: Array<{
      id: string;
      label: string;
    }>;
  };
  agents: {
    general?: { llm?: MyClawConfig["llm"] };
    research?: { llm?: MyClawConfig["llm"] };
  };
}

export const MY_CLAW_DIR = join(homedir(), ".my-claw");

export async function loadConfig(): Promise<MyClawConfig> {
  await mkdir(MY_CLAW_DIR, { recursive: true });
  const configPath = join(MY_CLAW_DIR, "config.json");
  const raw = await readFile(configPath, "utf-8");
  return JSON.parse(raw) as MyClawConfig;
}
