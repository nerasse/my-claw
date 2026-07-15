import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { join } from "node:path";
import { MY_CLAW_DIR } from "../../core/config.ts";
import type { EffortLevel } from "../../core/config.ts";
import { log } from "../../utils/logger.ts";

export interface DiscoveredSdkModel {
  value: string;
  resolvedModel?: string;
  displayName: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: EffortLevel[];
}

const DISCOVER_TIMEOUT_MS = 30_000;

/**
 * Ask the Claude CLI (via the SDK control channel) for the models this account can use. Runs a
 * throwaway query, reads the `supportedModels` control response, and aborts before any model
 * turn executes — so it costs a subprocess spawn, not tokens. Auth flows through the same
 * CLAUDE_CONFIG_DIR the run backend uses (subscription OAuth).
 */
export async function discoverSdkModels(): Promise<DiscoveredSdkModel[]> {
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), DISCOVER_TIMEOUT_MS);
  try {
    const q = sdkQuery({
      prompt: "noop",
      options: {
        executable: "bun",
        abortController,
        settingSources: [],
        env: {
          ...process.env,
          CLAUDE_CODE_ENABLE_TASKS: "0",
          CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
          CLAUDE_CONFIG_DIR: join(MY_CLAW_DIR, "claude-sdk"),
        },
      },
    });
    const models = (await q.supportedModels()) as DiscoveredSdkModel[];
    return models;
  } finally {
    // Abort the never-consumed stream so the subprocess exits promptly.
    abortController.abort();
    clearTimeout(timer);
    void log("info", "claude-sdk model discovery done");
  }
}
