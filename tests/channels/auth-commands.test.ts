import { test, beforeEach, afterEach } from "bun:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { MY_CLAW_DIR } from "../../src/core/config.ts";
import { handleAuthCommand } from "../../src/channels/auth-commands.ts";
import { resetClaudeAuthState, loadClaudeToken, clearClaudeToken } from "../../src/llm/claude-auth.ts";

const noop = () => {};
// MY_CLAW_DIR is shared across test files, so another suite may leave a codex
// credential behind. Clear it before each test so "fresh install" holds
// regardless of file execution order.
beforeEach(() => {
  rmSync(join(MY_CLAW_DIR, "accounts"), { recursive: true, force: true });
});
afterEach(async () => {
  await clearClaudeToken("anthropic");
});

test("codex status reports not connected on a fresh install", async () => {
  const out = await handleAuthCommand({ provider: "codex", account: "chatgpt", args: "status", isDm: true, postFollowUp: noop });
  assert.match(out, /non connecté/);
});

test("codex login is refused outside a DM", async () => {
  const out = await handleAuthCommand({ provider: "codex", account: "chatgpt", args: "login", isDm: false, postFollowUp: noop });
  assert.match(out, /message privé/);
});

test("codex unknown subcommand shows usage", async () => {
  const out = await handleAuthCommand({ provider: "codex", account: "chatgpt", args: "wat", isDm: true, postFollowUp: noop });
  assert.match(out, /\/codex login/);
});

test("codex logout triggers onAuthChanged so discovery reruns", async () => {
  const kinds: string[] = [];
  await handleAuthCommand({ provider: "codex", account: "chatgpt", args: "logout", isDm: true, postFollowUp: noop, onAuthChanged: (k) => { kinds.push(k); } });
  assert.deepEqual(kinds, ["chatgpt"]);
});

test("codex logout refused outside a DM does not fire onAuthChanged", async () => {
  let called = 0;
  const out = await handleAuthCommand({ provider: "codex", account: "chatgpt", args: "logout", isDm: false, postFollowUp: noop, onAuthChanged: () => { called += 1; } });
  assert.match(out, /message privé/);
  assert.equal(called, 0);
});

test("claude set-token triggers onAuthChanged so Claude discovery reruns", async () => {
  const kinds: string[] = [];
  await handleAuthCommand({ provider: "claude", account: "anthropic", args: "set-token sk-ant-oat01-secret", isDm: true, postFollowUp: noop, onAuthChanged: (k) => { kinds.push(k); } });
  assert.deepEqual(kinds, ["anthropic"]);
});

test("claude logout triggers onAuthChanged", async () => {
  const kinds: string[] = [];
  await handleAuthCommand({ provider: "claude", account: "anthropic", args: "logout", isDm: true, postFollowUp: noop, onAuthChanged: (k) => { kinds.push(k); } });
  assert.deepEqual(kinds, ["anthropic"]);
});

test("claude set-token stores the token and is DM-gated", async () => {
  const denied = await handleAuthCommand({ provider: "claude", account: "anthropic", args: "set-token sk-ant-xyz", isDm: false, postFollowUp: noop });
  assert.match(denied, /message privé/);

  const ok = await handleAuthCommand({ provider: "claude", account: "anthropic", args: "set-token sk-ant-oat01-secret", isDm: true, postFollowUp: noop });
  assert.match(ok, /token enregistré/);
  assert.equal(await loadClaudeToken("anthropic"), "sk-ant-oat01-secret");
});

test("claude set-token without a token shows usage", async () => {
  const out = await handleAuthCommand({ provider: "claude", account: "anthropic", args: "set-token", isDm: true, postFollowUp: noop });
  assert.match(out, /set-token <token>/);
});

test("claude login hands out the authorize url and names the step that follows", async () => {
  const out = await handleAuthCommand({ provider: "claude", account: "anthropic", args: "login", isDm: true, postFollowUp: noop });
  assert.match(out, /platform\.claude\.com\/oauth\/authorize/);
  assert.match(out, /code_challenge_method=S256/);
  // The code has to come back through the chat, so the reply must say how.
  assert.match(out, /\/claude code/);
});

test("claude login and claude code are private-only, like every credential path", async () => {
  for (const args of ["login", "code abc"]) {
    const out = await handleAuthCommand({ provider: "claude", account: "anthropic", args, isDm: false, postFollowUp: noop });
    assert.match(out, /message priv/);
  }
});

test("claude code without a started login refuses instead of calling out", async () => {
  resetClaudeAuthState();
  const out = await handleAuthCommand({ provider: "claude", account: "anthropic", args: "code some-code", isDm: true, postFollowUp: noop });
  assert.match(out, /No login in progress/);
});

test("claude code with no argument shows usage", async () => {
  const out = await handleAuthCommand({ provider: "claude", account: "anthropic", args: "code", isDm: true, postFollowUp: noop });
  assert.match(out, /code <code>/);
});

test("claude status reflects a stored token", async () => {
  await handleAuthCommand({ provider: "claude", account: "anthropic", args: "set-token sk-ant-oat01-secret", isDm: true, postFollowUp: noop });
  const out = await handleAuthCommand({ provider: "claude", account: "anthropic", args: "status", isDm: true, postFollowUp: noop });
  assert.match(out, /connecté/);
});
