import { test, afterEach } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { MY_CLAW_DIR } from "../../src/core/config.ts";
import { getCodexAccessToken, loadCodexCredential, codexLogout } from "../../src/llm/codex-auth.ts";

const AUTH_PATH = join(MY_CLAW_DIR, "codex", "auth.json");

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

// A JWT the account-id decoder can read: header.payload.signature, payload carrying the claim.
function fakeJwt(accountId: string): string {
  const header = b64url({ alg: "none" });
  const payload = b64url({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } });
  return `${header}.${payload}.sig`;
}

function writeAuth(cred: Record<string, unknown>): void {
  mkdirSync(join(MY_CLAW_DIR, "codex"), { recursive: true });
  writeFileSync(AUTH_PATH, JSON.stringify(cred));
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  // MY_CLAW_DIR is shared across test files; leaking a codex credential breaks
  // other suites that assume a fresh (logged-out) state.
  rmSync(join(MY_CLAW_DIR, "codex"), { recursive: true, force: true });
});

test("getCodexAccessToken returns the stored token when not near expiry", async () => {
  writeAuth({ access: "acc", refresh: "ref", expires: Date.now() + 3_600_000, accountId: "acct-1" });
  const { accessToken, accountId } = await getCodexAccessToken();
  assert.equal(accessToken, "acc");
  assert.equal(accountId, "acct-1");
});

test("getCodexAccessToken refreshes an expiring token and persists the rotation", async () => {
  writeAuth({ access: "old", refresh: "old-refresh", expires: Date.now() + 1000, accountId: "acct-1" });
  const newAccess = fakeJwt("acct-2");
  let calledWith: URLSearchParams | undefined;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    calledWith = new URLSearchParams(String(init?.body));
    return new Response(JSON.stringify({ access_token: newAccess, refresh_token: "new-refresh", expires_in: 3600 }), { status: 200 });
  }) as typeof fetch;

  const { accessToken, accountId } = await getCodexAccessToken();
  assert.equal(accessToken, newAccess);
  assert.equal(accountId, "acct-2");
  assert.equal(calledWith?.get("grant_type"), "refresh_token");
  assert.equal(calledWith?.get("refresh_token"), "old-refresh");

  const persisted = JSON.parse(readFileSync(AUTH_PATH, "utf-8")) as { refresh: string; accountId: string };
  assert.equal(persisted.refresh, "new-refresh");
  assert.equal(persisted.accountId, "acct-2");
});

test("getCodexAccessToken throws a helpful message when not logged in", async () => {
  await codexLogout();
  await assert.rejects(getCodexAccessToken(), /Not logged in to Codex/);
});

test("loadCodexCredential returns null after logout", async () => {
  writeAuth({ access: "acc", refresh: "ref", expires: Date.now() + 3_600_000, accountId: "acct-1" });
  await codexLogout();
  assert.equal(await loadCodexCredential(), null);
});
