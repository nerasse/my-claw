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
  workspace?: string;
}

export const MY_CLAW_DIR = join(homedir(), ".my-claw");

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
  const configPath = join(MY_CLAW_DIR, "config.json");
  const raw = await readFile(configPath, "utf-8");
  const config = JSON.parse(raw) as MyClawConfig;
  const workspacePath = config.workspace ?? join(MY_CLAW_DIR, "workspace");
  await mkdir(workspacePath, { recursive: true });
  await seedWorkspaceTemplates(workspacePath);
  config.workspace = workspacePath;
  return config;
}
