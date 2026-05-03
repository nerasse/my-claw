import { readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

export interface MyClawConfig {
  whitelist: string[];
  blacklist: string[];
  channels: {
    telegram?: { token: string };
    matrix?: { homeserver: string; accessToken: string; userId: string };
  };
  llm: {
    provider: string;
    baseUrl: string;
    model: string;
    apiKey?: string;
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
