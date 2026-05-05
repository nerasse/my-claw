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

export interface MyClawConfig {
  whitelist: string[];
  blacklist: string[];
  channels: {
    telegram?: TelegramChannelConfig;
    matrix?: { homeserver: string; accessToken: string; userId: string };
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
