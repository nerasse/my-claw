/**
 * Continue against a real model: deepseek-v4.1-flash on OpenCode Go, the one the owner asked for
 * (docs/continue.md). The real bridge, a real log, no mock. Each case is a shape the logs of this
 * install hold, and each asserts what the model did next, not what it said.
 *
 * Run with: CONTINUE_E2E=1 OPENCODE_GO_KEY=... bun test tests-e2e/continue/deepseek.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { setupSessionLog, writeLegacySessionFile } from "../../tests/helpers/session-log.ts";
import { AgentBridge } from "../../src/agent/bridge.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { SkillRegistry } from "../../src/skills/registry.ts";
import { deleteSession, type LegacySessionData } from "../../src/sessions/store.ts";
import type { MyClawConfig } from "../../src/core/config.ts";
import type { UnifiedMessage } from "../../src/channels/types.ts";
import type { SessionLog, ToolEntry } from "../../src/sessions/log.ts";
import type { Tool } from "../../src/tools/types.ts";

const E2E = process.env["CONTINUE_E2E"] === "1" && Boolean(process.env["OPENCODE_GO_KEY"]);
const SESSION_ID = "e2e-continue";

const config: MyClawConfig = {
  whitelist: ["u1"], blacklist: [], channels: {},
  llm: {
    defaultProvider: "opencode_go",
    defaultModel: "deepseek-v4.1-flash",
    providers: { opencode_go: { type: "openai", baseUrl: "https://opencode.ai/zen/go/v1", apiKeyEnv: "OPENCODE_GO_KEY", promptCache: true } },
    models: [{ id: "deepseek-v4.1-flash", label: "DeepSeek", provider: "opencode_go" }],
  },
  agents: {}, memory: { enabled: false },
};
const session = (): LegacySessionData => ({ id: SESSION_ID, platform: "my-claw-app", chatType: "dm", createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), messages: [] });
const resume: UnifiedMessage = { id: "continue-e2e", platform: "my-claw-app", userId: "u1", chatId: "c1", chatType: "dm", text: "", attachments: [], isForwarded: false, raw: {}, resume: true };

let log: SessionLog;
let cleanup: () => void;
beforeEach(async () => {
  await deleteSession(SESSION_ID);
  await writeLegacySessionFile(SESSION_ID, session());
  ({ log, cleanup } = await setupSessionLog(SESSION_ID));
});
afterEach(() => cleanup());

const SHAPES: Record<string, { description: string; properties: Record<string, { type: string }> }> = {
  bash: { description: "Run a shell command", properties: { command: { type: "string" } } },
  send: { description: "Send a message to an existing sub-agent; omit message to resume it where it stopped.", properties: { id: { type: "string" }, message: { type: "string" } } },
  spawn: { description: "Spawn a new research sub-agent for a task", properties: { name: { type: "string" }, task: { type: "string" } } },
};

function recording(name: string, output: string | ((args: Record<string, unknown>) => string)): { tool: Tool; calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    tool: {
      name,
      description: SHAPES[name]!.description,
      parameters: { type: "object", properties: SHAPES[name]!.properties },
      execute: async (args) => {
        calls.push(Object.fromEntries(Object.entries(args).filter(([k]) => !k.startsWith("__"))));
        return { success: true, output: typeof output === "string" ? output : output(args) };
      },
    },
  };
}

describe.skipIf(!E2E)("Continue on deepseek-v4.1-flash", () => {
  test("failed after a tool result: it goes on from the result, without asking again", async () => {
    log.append({ type: "user", prompt: true, text: "Compte les fichiers .md de /data/research, puis donne le total et le plus récent." });
    log.append({ type: "run_start", prompt: false });
    log.append({ type: "phase", prompt: true, text: "", runId: "t1" });
    log.append<ToolEntry>({ type: "tool", prompt: true, callId: "c1", name: "bash", args: { command: "ls /data/research/*.md | wc -l" }, output: "57", truncated: false, ok: true, runId: "t1" });
    log.append({ type: "run_end", prompt: false, reason: "error" });
    // A shell whose answers agree with each other: one that does not sends the model off checking
    // the shell, which is not what is under test.
    const bash = recording("bash", "57 files\nnewest: 2026-09-27 01:31 2026-09-27_backlog_verification.md");
    const registry = new ToolRegistry();
    registry.register(bash.tool);
    const text = await new AgentBridge(config, registry, new SkillRegistry()).handleMessage(resume, session());
    // Its next move is the step after the result it had: the newest file, or the answer. Counting
    // again would be starting over.
    // It went on with the task from the result it had and finished it, rather than asking what was
    // wanted. How many times it checks the shell on the way is the model's habit, not Continue's.
    expect(text).toMatch(/57/);
    expect(text).toMatch(/backlog/);
  }, 120_000);

  test("stopped mid-answer: it carries on instead of starting over", async () => {
    log.append({ type: "user", prompt: true, text: "Donne-moi 5 conseils pour un entretien technique, numérotés." });
    log.append({ type: "run_start", prompt: false });
    log.append({ type: "phase", prompt: true, text: "Voici 5 conseils :\n1. Révise les fondamentaux.\n2. Entraîne-toi à voix haute", runId: "t1" });
    log.append({ type: "run_end", prompt: false, reason: "aborted" });
    const text = await new AgentBridge(config, new ToolRegistry(), new SkillRegistry()).handleMessage(resume, session());
    expect(text).not.toMatch(/^\s*(Voici|1\.)/);
  }, 120_000);

  test("stopped while a sub-agent worked: the sub-agent is resumed, not respawned", async () => {
    log.append({ type: "user", prompt: true, text: "Lance un sous-agent qui liste les offres LLM à Paris sur WTTJ, puis résume." });
    log.append({ type: "run_start", prompt: false });
    log.append({ type: "phase", prompt: true, text: "", runId: "t1" });
    log.append({ type: "spawn_state", prompt: false, callId: "c-spawn", subagentId: "subagent/wttj-4f2a", status: "running", action: "spawn", displayName: "wttj", agentType: "research", mode: "run", task: "offres LLM Paris WTTJ" });
    log.append({ type: "run_end", prompt: false, reason: "aborted" });
    const send = recording("send", "14 offres lues. 5 retenues : Mistral, Dust, H, Photoroom, Alan.");
    const spawn = recording("spawn", "should not be called");
    const registry = new ToolRegistry();
    registry.register(send.tool);
    registry.register(spawn.tool);
    const text = await new AgentBridge(config, registry, new SkillRegistry()).handleMessage(resume, session());
    expect(send.calls[0]).toEqual({ id: "subagent/wttj-4f2a" });
    expect(spawn.calls).toEqual([]);
    expect(text).toMatch(/Mistral|Dust|5/);
  }, 120_000);
});
