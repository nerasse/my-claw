import { test, afterEach } from "bun:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { MY_CLAW_DIR } from "../../src/core/config.ts";
import { clearClaudeToken, resetClaudeAuthState } from "../../src/llm/claude-auth.ts";
import { createAccounts, type AccountKind, type AccountsState } from "../../src/llm/subscription-accounts.ts";
import { mockFetch } from "../helpers/mock-fetch.ts";

const ENV = "CLAUDE_CODE_OAUTH_TOKEN";
const savedEnv = process.env[ENV];
let mock: { restore(): void } | undefined;
afterEach(async () => {
  mock?.restore();
  mock = undefined;
  rmSync(join(MY_CLAW_DIR, "codex"), { recursive: true, force: true });
  await clearClaudeToken();
  resetClaudeAuthState();
  if (savedEnv === undefined) delete process.env[ENV];
  else process.env[ENV] = savedEnv;
});

function jwt(claims: Record<string, unknown>): string {
  const part = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${part({ alg: "none" })}.${part(claims)}.sig`;
}

const ACCESS = jwt({
  "https://api.openai.com/auth": { chatgpt_account_id: "acc-1", chatgpt_plan_type: "plus" },
  "https://api.openai.com/profile": { email: "owner@example.com" },
});

/** OpenAI's device flow: a code, `pending` polls until `approve()`, then the token exchange. */
function openAi() {
  let approved = false;
  let codes = 0;
  mock = mockFetch(async (input) => {
    const url = String(input);
    if (url.endsWith("/deviceauth/usercode")) {
      codes++;
      return Response.json({ device_auth_id: "dev-1", user_code: `ABCD-${codes}`, interval: "1" });
    }
    if (url.endsWith("/deviceauth/token")) {
      return approved
        ? Response.json({ authorization_code: "auth-code", code_verifier: "verifier" })
        : new Response("{}", { status: 403 });
    }
    if (url.endsWith("/oauth/token")) return Response.json({ access_token: ACCESS, refresh_token: "r", expires_in: 3600 });
    return new Response("unexpected", { status: 500 });
  });
  return { approve: () => (approved = true), codes: () => codes };
}

function harness() {
  const changed: AccountKind[] = [];
  let settle: (v: { state: AccountsState; error?: string }) => void = () => {};
  const settled = new Promise<{ state: AccountsState; error?: string }>((resolve) => (settle = resolve));
  const accounts = createAccounts({
    onAuthChanged: async (kind) => void changed.push(kind),
    onSettled: (state, error) => settle({ state, ...(error ? { error } : {}) }),
  });
  return { accounts, changed, settled };
}

test("ChatGPT: the code to enter survives a second tap, and the approval lands as a pushed outcome", async () => {
  const server = openAi();
  const { accounts, changed, settled } = harness();

  const started = await accounts.login("codex");
  assert.equal(started.codex.connected, false);
  assert.equal(started.codex.login?.code, "ABCD-1");
  assert.equal(started.codex.login?.url, "https://auth.openai.com/codex/device");
  // The page reopened, or a second tap: the same code, no second device request.
  assert.equal((await accounts.login("codex")).codex.login?.code, "ABCD-1");
  assert.equal(server.codes(), 1);

  server.approve();
  const { state, error } = await settled;
  assert.equal(error, undefined);
  assert.deepEqual(state.codex, { connected: true, email: "owner@example.com", plan: "plus" });
  assert.deepEqual(changed, ["codex"]);
});

test("ChatGPT: a cancel drops the code, a new sign-in asks a fresh one; sign-out removes the account", async () => {
  const server = openAi();
  const { accounts, changed } = harness();
  await accounts.login("codex");
  const cancelled = await accounts.cancel("codex");
  assert.equal(cancelled.codex.login, undefined);
  server.approve();
  // A new sign-in asks a fresh code: the cancelled one is gone.
  assert.equal((await accounts.login("codex")).codex.login?.code, "ABCD-2");
  await accounts.cancel("codex");

  const out = await accounts.logout("codex");
  assert.equal(out.codex.connected, false);
  assert.deepEqual(changed, ["codex"]);
});

test("Claude: sign-in gives the page to open; a long-lived token connects it; sign-out disconnects", async () => {
  delete process.env[ENV];
  const { accounts, changed } = harness();
  const started = await accounts.login("claude");
  assert.match(started.claude.login?.url ?? "", /^https:\/\/platform\.claude\.com\/oauth\/authorize\?/);
  assert.equal(started.claude.connected, false);

  const withToken = await accounts.token(`sk-ant-oat01-${"x".repeat(40)}`);
  assert.equal(withToken.claude.connected, true);
  assert.equal(withToken.claude.source, "token");

  const out = await accounts.logout("claude");
  assert.equal(out.claude.connected, false);
  assert.equal(out.claude.login, undefined);
  assert.deepEqual(changed, ["claude", "claude"]);
});

test("Claude: a token from the server's environment reads as such, so the page can say where it lives", async () => {
  process.env[ENV] = `sk-ant-oat01-${"y".repeat(40)}`;
  const { accounts } = harness();
  const state = await accounts.status();
  assert.equal(state.claude.connected, true);
  assert.equal(state.claude.source, "env");
});
