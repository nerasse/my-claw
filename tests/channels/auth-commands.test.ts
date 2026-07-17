import { test, afterEach } from "bun:test";
import assert from "node:assert/strict";
import { handleAuthCommand } from "../../src/channels/auth-commands.ts";
import { loadClaudeToken, clearClaudeToken } from "../../src/llm/claude-auth.ts";

const noop = () => {};
afterEach(async () => {
  await clearClaudeToken();
});

test("codex status reports not connected on a fresh install", async () => {
  const out = await handleAuthCommand({ provider: "codex", args: "status", isDm: true, postFollowUp: noop });
  assert.match(out, /non connecté/);
});

test("codex login is refused outside a DM", async () => {
  const out = await handleAuthCommand({ provider: "codex", args: "login", isDm: false, postFollowUp: noop });
  assert.match(out, /message privé/);
});

test("codex unknown subcommand shows usage", async () => {
  const out = await handleAuthCommand({ provider: "codex", args: "wat", isDm: true, postFollowUp: noop });
  assert.match(out, /\/codex login/);
});

test("claude set-token stores the token and is DM-gated", async () => {
  const denied = await handleAuthCommand({ provider: "claude", args: "set-token sk-ant-xyz", isDm: false, postFollowUp: noop });
  assert.match(denied, /message privé/);

  const ok = await handleAuthCommand({ provider: "claude", args: "set-token sk-ant-oat01-secret", isDm: true, postFollowUp: noop });
  assert.match(ok, /token enregistré/);
  assert.equal(await loadClaudeToken(), "sk-ant-oat01-secret");
});

test("claude set-token without a token shows usage", async () => {
  const out = await handleAuthCommand({ provider: "claude", args: "set-token", isDm: true, postFollowUp: noop });
  assert.match(out, /set-token <token>/);
});

test("claude login returns terminal/paste instructions (no in-chat OAuth)", async () => {
  const out = await handleAuthCommand({ provider: "claude", args: "login", isDm: true, postFollowUp: noop });
  assert.match(out, /setup-token/);
  assert.match(out, /set-token/);
});

test("claude status reflects a stored token", async () => {
  await handleAuthCommand({ provider: "claude", args: "set-token sk-ant-oat01-secret", isDm: true, postFollowUp: noop });
  const out = await handleAuthCommand({ provider: "claude", args: "status", isDm: true, postFollowUp: noop });
  assert.match(out, /connecté/);
});
