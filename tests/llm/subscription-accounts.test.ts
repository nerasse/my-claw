import { test, afterEach } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { MY_CLAW_DIR, type LlmProviderConfig } from "../../src/core/config.ts";
import { resetClaudeAuthState, loadClaudeToken } from "../../src/llm/claude-auth.ts";
import { accountKeyFor, createAccounts, type AccountKind, type AccountsState } from "../../src/llm/subscription-accounts.ts";
import { adoptLegacyAccounts } from "../../src/llm/accounts-store.ts";
import { mockFetch } from "../helpers/mock-fetch.ts";

const ENV = "CLAUDE_CODE_OAUTH_TOKEN";
const savedEnv = process.env[ENV];
let mock: { restore(): void } | undefined;
afterEach(() => {
  mock?.restore();
  mock = undefined;
  for (const dir of ["accounts", "codex", "claude"]) rmSync(join(MY_CLAW_DIR, dir), { recursive: true, force: true });
  rmSync(join(MY_CLAW_DIR, ".env"), { force: true });
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

function harness(initial: Record<string, LlmProviderConfig> = { chatgpt: { type: "codex" }, anthropic: { type: "anthropic", group: "Claude" } }) {
  const providers: Record<string, LlmProviderConfig> = { ...initial };
  const changed: string[] = [];
  let settle: (v: { state: AccountsState; error?: string }) => void = () => {};
  const settled = new Promise<{ state: AccountsState; error?: string }>((resolve) => (settle = resolve));
  const accounts = createAccounts({
    providers: () => providers,
    addProvider: async (key, kind: AccountKind, name) => {
      providers[key] = kind === "codex" ? { type: "codex", group: name } : { type: "anthropic", group: name };
    },
    renameProvider: async (key, name) => {
      providers[key] = { ...providers[key]!, group: name };
    },
    onAuthChanged: async (provider) => void changed.push(provider),
    onSettled: (state, error) => settle({ state, ...(error ? { error } : {}) }),
  });
  return { accounts, changed, settled, providers };
}

const view = (state: AccountsState, provider: string) => state.accounts.find((a) => a.provider === provider);

test("ChatGPT: the code to enter survives a second tap, and the approval lands as a pushed outcome", async () => {
  const server = openAi();
  const { accounts, changed, settled } = harness();

  const started = await accounts.login("chatgpt");
  assert.equal(view(started, "chatgpt")?.connected, false);
  assert.equal(view(started, "chatgpt")?.login?.code, "ABCD-1");
  assert.equal(view(started, "chatgpt")?.login?.url, "https://auth.openai.com/codex/device");
  // The page reopened, or a second tap: the same code, no second device request.
  assert.equal(view(await accounts.login("chatgpt"), "chatgpt")?.login?.code, "ABCD-1");
  assert.equal(server.codes(), 1);

  server.approve();
  const { state, error } = await settled;
  assert.equal(error, undefined);
  assert.deepEqual(view(state, "chatgpt"), { provider: "chatgpt", kind: "codex", name: "chatgpt", connected: true, email: "owner@example.com", plan: "plus" });
  // An app older than 0.6.129 reads the first account of each kind under its kind.
  assert.deepEqual(state.codex, { connected: true, email: "owner@example.com", plan: "plus" });
  assert.deepEqual(changed, ["chatgpt"]);
});

test("ChatGPT: a cancel drops the code, a new sign-in asks a fresh one; sign-out removes the account", async () => {
  const server = openAi();
  const { accounts, changed } = harness();
  await accounts.login("chatgpt");
  const cancelled = await accounts.cancel("chatgpt");
  assert.equal(view(cancelled, "chatgpt")?.login, undefined);
  server.approve();
  assert.equal(view(await accounts.login("chatgpt"), "chatgpt")?.login?.code, "ABCD-2");
  await accounts.cancel("chatgpt");

  const out = await accounts.logout("chatgpt");
  assert.equal(view(out, "chatgpt")?.connected, false);
  assert.deepEqual(changed, ["chatgpt"]);
});

test("Claude: sign-in gives the page to open; a long-lived token connects it; sign-out disconnects", async () => {
  const { accounts, changed } = harness();
  const started = await accounts.login("anthropic");
  assert.match(view(started, "anthropic")?.login?.url ?? "", /^https:\/\/platform\.claude\.com\/oauth\/authorize\?/);
  assert.equal(view(started, "anthropic")?.connected, false);

  const withToken = await accounts.token("anthropic", `sk-ant-oat01-${"x".repeat(40)}`);
  assert.equal(view(withToken, "anthropic")?.connected, true);
  assert.equal(view(withToken, "anthropic")?.source, "token");
  assert.equal(view(withToken, "anthropic")?.name, "Claude");

  const out = await accounts.logout("anthropic");
  assert.equal(view(out, "anthropic")?.connected, false);
  assert.equal(view(out, "anthropic")?.login, undefined);
  assert.deepEqual(changed, ["anthropic", "anthropic"]);
});

test("two ChatGPT accounts, named by the owner, each with its own sign-in", async () => {
  openAi();
  const { accounts, providers } = harness();
  const added = await accounts.add("codex", "ChatGPT boulot");
  assert.equal(added.added, "chatgpt-boulot");
  assert.deepEqual(providers["chatgpt-boulot"], { type: "codex", group: "ChatGPT boulot" });
  // A second one of the same name never lands on the first one's key, nor its sign-in.
  assert.equal((await accounts.add("codex", "ChatGPT boulot")).added, "chatgpt-boulot-2");

  mkdirSync(join(MY_CLAW_DIR, "accounts"), { recursive: true });
  writeFileSync(join(MY_CLAW_DIR, "accounts", "chatgpt-boulot.json"), JSON.stringify({ access: ACCESS, refresh: "r", expires: Date.now() + 3_600_000, accountId: "acc-1" }));
  const state = await accounts.status();
  assert.equal(view(state, "chatgpt-boulot")?.connected, true);
  assert.equal(view(state, "chatgpt")?.connected, false);
  assert.equal(view(state, "chatgpt-boulot")?.name, "ChatGPT boulot");

  const renamed = await accounts.rename("chatgpt-boulot", "Work");
  assert.equal(view(renamed, "chatgpt-boulot")?.name, "Work");
  await assert.rejects(accounts.rename("chatgpt-boulot", "   "), /cannot be empty/);
});

test("a key from a name: accents and spaces folded, a taken one numbered, an empty one by kind", () => {
  assert.equal(accountKeyFor("Claude Équipe", "claude", new Set()), "claude-equipe");
  assert.equal(accountKeyFor("perso", "codex", new Set(["perso", "perso-2"])), "perso-3");
  assert.equal(accountKeyFor("  !!! ", "codex", new Set()), "chatgpt");
});

test("an action names an account that exists: a provider that is not a plan is refused", async () => {
  const { accounts } = harness({ chatgpt: { type: "codex" }, openrouter: { baseUrl: "https://openrouter.ai/api/v1" } });
  await assert.rejects(accounts.login("openrouter"), /No ChatGPT or Claude account/);
  await assert.rejects(accounts.token("chatgpt", "sk-ant-oat01-xxxxxxxxxxxxxxxxxxxxxxxx"), /for a Claude account/);
});

test("the Claude token of .env is adopted by the first Claude plan, then gone from .env", async () => {
  const token = `sk-ant-oat01-${"e".repeat(40)}`;
  writeFileSync(join(MY_CLAW_DIR, ".env"), `GROQ_API_KEY=g\n${ENV}=${token}\n`);
  process.env[ENV] = token;
  const providers = { openrouter: { baseUrl: "https://x" }, anthropic: { type: "anthropic" as const }, "claude-2": { type: "anthropic" as const } };
  await adoptLegacyAccounts(providers);
  assert.equal(await loadClaudeToken("anthropic"), token);
  assert.equal(await loadClaudeToken("claude-2"), null);
  assert.equal(process.env[ENV], undefined);
  const env = readFileSync(join(MY_CLAW_DIR, ".env"), "utf-8");
  assert.ok(!env.includes(ENV));
  assert.ok(env.includes("GROQ_API_KEY=g"));
});

test("an account already signed in keeps its sign-in; the .env line goes all the same", async () => {
  mkdirSync(join(MY_CLAW_DIR, "accounts"), { recursive: true });
  writeFileSync(join(MY_CLAW_DIR, "accounts", "anthropic.json"), JSON.stringify({ token: "sk-ant-oat01-kept" }));
  writeFileSync(join(MY_CLAW_DIR, ".env"), `${ENV}=sk-ant-oat01-other\n`);
  process.env[ENV] = "sk-ant-oat01-other";
  await adoptLegacyAccounts({ anthropic: { type: "anthropic" } });
  assert.equal(await loadClaudeToken("anthropic"), "sk-ant-oat01-kept");
  assert.ok(!readFileSync(join(MY_CLAW_DIR, ".env"), "utf-8").includes(ENV));
});

test("the one-per-server sign-ins of before go to the first provider of their kind, and leave", async () => {
  mkdirSync(join(MY_CLAW_DIR, "codex"), { recursive: true });
  mkdirSync(join(MY_CLAW_DIR, "claude"), { recursive: true });
  const cred = { access: ACCESS, refresh: "r", expires: Date.now() + 3_600_000, accountId: "acc-1" };
  writeFileSync(join(MY_CLAW_DIR, "codex", "auth.json"), JSON.stringify(cred));
  writeFileSync(join(MY_CLAW_DIR, "claude", "auth.json"), JSON.stringify({ token: "sk-ant-oat01-legacy" }));
  delete process.env[ENV];
  await adoptLegacyAccounts({ keyed: { type: "anthropic", apiKeyEnv: "ANTHROPIC_API_KEY" }, chatgpt: { type: "codex" }, anthropic: { type: "anthropic" } });
  assert.deepEqual(JSON.parse(readFileSync(join(MY_CLAW_DIR, "accounts", "chatgpt.json"), "utf-8")), cred);
  // The keyed Anthropic provider is not a plan: the subscription went to the one that is.
  assert.equal(await loadClaudeToken("anthropic"), "sk-ant-oat01-legacy");
  assert.equal(existsSync(join(MY_CLAW_DIR, "accounts", "keyed.json")), false);
  assert.equal(existsSync(join(MY_CLAW_DIR, "codex", "auth.json")), false);
  assert.equal(existsSync(join(MY_CLAW_DIR, "claude", "auth.json")), false);
});
