import { test, afterEach } from "bun:test";
import assert from "node:assert/strict";
import { loadClaudeToken, setClaudeToken, clearClaudeToken, claudeTokenStatus } from "../../src/llm/claude-auth.ts";

const ENV = "CLAUDE_CODE_OAUTH_TOKEN";
const savedEnv = process.env[ENV];
afterEach(async () => {
  if (savedEnv === undefined) delete process.env[ENV];
  else process.env[ENV] = savedEnv;
  await clearClaudeToken();
});

test("setClaudeToken then loadClaudeToken round-trips the token", async () => {
  await setClaudeToken("sk-ant-oat01-abcdefghij-XYZ");
  assert.equal(await loadClaudeToken(), "sk-ant-oat01-abcdefghij-XYZ");
});

test("setClaudeToken rejects an empty token", async () => {
  await assert.rejects(setClaudeToken("   "), /empty token/);
});

test("status reports the my-claw file source and masks the token", async () => {
  await setClaudeToken("sk-ant-oat01-abcdefghij-XYZ");
  const st = await claudeTokenStatus();
  assert.equal(st.present, true);
  assert.equal(st.source, "my-claw");
  assert.ok(st.masked && st.masked.startsWith("sk-ant-oat"));
  assert.ok(!st.masked!.includes("abcdefghij-XYZ"));
});

test("loadClaudeToken falls back to the env token when no file is stored", async () => {
  await clearClaudeToken();
  process.env[ENV] = "sk-ant-env-token";
  assert.equal(await loadClaudeToken(), "sk-ant-env-token");
  const st = await claudeTokenStatus();
  assert.equal(st.source, "env");
});

test("the my-claw file token wins over the env token", async () => {
  process.env[ENV] = "sk-ant-env-token";
  await setClaudeToken("sk-ant-file-token");
  assert.equal(await loadClaudeToken(), "sk-ant-file-token");
});

test("clearClaudeToken removes the stored token", async () => {
  await setClaudeToken("sk-ant-file-token");
  await clearClaudeToken();
  delete process.env[ENV];
  assert.equal(await loadClaudeToken(), null);
  assert.equal((await claudeTokenStatus()).present, false);
});
