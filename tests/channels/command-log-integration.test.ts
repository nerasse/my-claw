import { test } from "bun:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createTelegramCommandHandler } from "../../src/channels/telegram/session-handlers.ts";
import { SessionManager } from "../../src/sessions/manager.ts";
import { ModelPicker } from "../../src/channels/model-picker.ts";
import { MY_CLAW_DIR } from "../../src/core/config.ts";
import type { MyClawConfig } from "../../src/core/config.ts";

const config: MyClawConfig = {
  whitelist: ["u1"],
  blacklist: [],
  channels: {},
  llm: { provider: "x", baseUrl: "https://example.com", model: "base-model", models: [{ id: "base-model", label: "Base" }] },
  agents: {},
} as unknown as MyClawConfig;

async function readLogs(): Promise<string> {
  const dir = join(MY_CLAW_DIR, "logs");
  const files = await readdir(dir).catch(() => [] as string[]);
  const parts = await Promise.all(
    files.filter((f) => f.startsWith("orchestrator-")).map((f) => readFile(join(dir, f), "utf-8")),
  );
  return parts.join("");
}

/**
 * The logger is fire-and-forget, so the writes land on their own schedule. Re-reading until the
 * expected lines appear removes the dependence on machine speed that a fixed sleep encodes, and
 * the throw names the real cause instead of leaving a bare assert.match failure behind.
 */
async function readLogsUntil(done: (text: string) => boolean, timeoutMs = 10_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const text = await readLogs();
    if (done(text)) return text;
    if (Date.now() > deadline) throw new Error("timed out waiting for the command log writes to land");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("a command is logged with its session id, and a token argument never reaches the log", async () => {
  const sessionManager = new SessionManager();
  const handler = createTelegramCommandHandler({
    config,
    sessionManager,
    modelPicker: new ModelPicker(config.llm.models ?? []),
  });

  await handler("c1", "u1", "dm", "status", "");
  // The secret below is exactly what used to be written to disk in clear.
  await handler("c1", "u1", "dm", "claude", "set-token sk-ant-oat01-TOPSECRET-VALUE");
  await handler("c1", "u1", "dm", "definitely-not-a-command", "");
  // Waits on markers that do not depend on redaction: if the token ever leaks, the failure must
  // be the explicit leak assertion below, not a timeout on a missing "[redacted]" marker.
  const logs = await readLogsUntil((text) =>
    text.includes('"message":"command received"')
    && text.includes('"command":"claude"')
    && text.includes('"message":"command not recognized"'));

  // The session id is what makes an incident reconstructible after the fact.
  assert.match(logs, /"message":"command received"/);
  assert.match(logs, /"sessionId":"telegram\/dm\/u1"/);
  assert.match(logs, /"command":"status"/);
  // An unrecognized command leaves a trace instead of vanishing silently.
  assert.match(logs, /"message":"command not recognized"/);
  assert.match(logs, /"command":"definitely-not-a-command"/);

  // The whole point of the redaction.
  assert.ok(!logs.includes("TOPSECRET"), "the token leaked into the log file");
  assert.match(logs, /"args":"set-token \[redacted\]"/);
}, 15_000);
