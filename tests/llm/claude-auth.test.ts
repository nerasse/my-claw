import { test, afterEach } from "bun:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MY_CLAW_DIR } from "../../src/core/config.ts";
import {
  loadClaudeToken,
  setClaudeToken,
  clearClaudeToken,
  claudeTokenStatus,
  claudeLoginStart,
  claudeLoginComplete,
  claudeLoginPending,
  resetClaudeAuthState,
} from "../../src/llm/claude-auth.ts";
import { mockFetch } from "../helpers/mock-fetch.ts";

const ENV = "CLAUDE_CODE_OAUTH_TOKEN";
const savedEnv = process.env[ENV];
afterEach(async () => {
  if (savedEnv === undefined) delete process.env[ENV];
  else process.env[ENV] = savedEnv;
  await clearClaudeToken();
  resetClaudeAuthState();
});

/**
 * Ages the stored credential. Refresh is time-driven and the clock is not a seam here, so the state
 * it reacts to is what the test moves.
 */
async function setStoredExpiryInThePast(): Promise<void> {
  const path = join(MY_CLAW_DIR, "claude", "auth.json");
  const file = JSON.parse(await readFile(path, "utf-8")) as { oauth?: { expires: number } };
  if (!file.oauth) throw new Error("no stored credential to age");
  file.oauth.expires = Date.now() - 1;
  await writeFile(path, JSON.stringify(file));
}

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

// ============================================================================
// OAuth: PKCE start, code exchange, refresh
// ============================================================================

/** Captures what the token endpoint was asked, so the wire shape is asserted and not assumed. */
function tokenEndpoint(reply: (body: Record<string, unknown>) => Response): {
  calls: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }>;
  restore(): void;
} {
  const calls: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }> = [];
  const mock = mockFetch(async (input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k] = v;
    calls.push({ url: String(input), body, headers });
    return reply(body);
  });
  return { calls, restore: mock.restore };
}

function ok(json: Record<string, unknown>): Response {
  return new Response(JSON.stringify(json), { status: 200, headers: { "content-type": "application/json" } });
}

test("the authorize url carries PKCE S256 and the scopes the CLI itself asks for", () => {
  const { url } = claudeLoginStart();
  const parsed = new URL(url);
  assert.equal(parsed.origin + parsed.pathname, "https://platform.claude.com/oauth/authorize");
  // `code=true` is what makes the callback page show the code instead of posting it back, which is
  // the only variant a chat channel can drive.
  assert.equal(parsed.searchParams.get("code"), "true");
  assert.equal(parsed.searchParams.get("code_challenge_method"), "S256");
  assert.equal(parsed.searchParams.get("response_type"), "code");
  assert.equal(parsed.searchParams.get("redirect_uri"), "https://platform.claude.com/oauth/code/callback");
  // What a real Claude Code login was granted, read off ~/.claude/.credentials.json. Not
  // `org:create_api_key`, which exists to step outside the subscription.
  assert.equal(
    parsed.searchParams.get("scope"),
    "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload",
  );
  const challenge = parsed.searchParams.get("code_challenge") ?? "";
  // base64url, so a padded or a standard-alphabet challenge would be a bug the server would reject.
  assert.match(challenge, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(claudeLoginPending());
});

test("two logins never reuse a verifier or a state", () => {
  const first = new URL(claudeLoginStart().url);
  const second = new URL(claudeLoginStart().url);
  assert.notEqual(first.searchParams.get("code_challenge"), second.searchParams.get("code_challenge"));
  assert.notEqual(first.searchParams.get("state"), second.searchParams.get("state"));
});

test("the code exchange sends the verifier and stores what came back", async () => {
  const url = new URL(claudeLoginStart().url);
  const ep = tokenEndpoint(() => ok({ access_token: "sk-ant-oat-new", refresh_token: "rt-1", expires_in: 28_800 }));
  try {
    const res = await claudeLoginComplete("code-from-the-page");
    assert.ok(res.expiresInMin > 470 && res.expiresInMin <= 480);
  } finally {
    ep.restore();
  }
  assert.equal(ep.calls.length, 1);
  assert.equal(ep.calls[0]!.url, "https://platform.claude.com/v1/oauth/token");
  assert.equal(ep.calls[0]!.body["grant_type"], "authorization_code");
  assert.equal(ep.calls[0]!.body["code"], "code-from-the-page");
  assert.equal(ep.calls[0]!.body["state"], url.searchParams.get("state"));
  assert.equal(ep.calls[0]!.body["redirect_uri"], "https://platform.claude.com/oauth/code/callback");
  assert.ok(String(ep.calls[0]!.body["code_verifier"]).length >= 43);
  // Same client the transport claims to be, so the account sees one consistent client.
  assert.match(ep.calls[0]!.headers["user-agent"] ?? "", /^claude-cli\//);

  assert.equal(await loadClaudeToken(), "sk-ant-oat-new");
  const st = await claudeTokenStatus();
  assert.equal(st.source, "oauth");
  assert.equal(st.hasFallbackToken, false);
  assert.ok(!claudeLoginPending());
});

test("the code is accepted in the three shapes the page hands out", async () => {
  for (const shape of ["plain-code", "pasted-code#STATE", "https://platform.claude.com/oauth/code/callback?code=url-code&state=STATE"]) {
    const url = new URL(claudeLoginStart().url);
    const state = url.searchParams.get("state")!;
    const ep = tokenEndpoint(() => ok({ access_token: "a", refresh_token: "r", expires_in: 100 }));
    try {
      await claudeLoginComplete(shape.replace(/STATE/g, state));
    } finally {
      ep.restore();
    }
    assert.equal(ep.calls.length, 1, shape);
  }
});

test("a code from another attempt is refused before it reaches the network", async () => {
  claudeLoginStart();
  const ep = tokenEndpoint(() => ok({}));
  try {
    await assert.rejects(claudeLoginComplete("code#not-our-state"), /another login attempt/);
  } finally {
    ep.restore();
  }
  assert.equal(ep.calls.length, 0);
});

test("a code with no login in progress is refused", async () => {
  resetClaudeAuthState();
  await assert.rejects(claudeLoginComplete("whatever"), /No login in progress/);
});

test("an access token inside the skew is refreshed, and a rotation that omits the refresh token keeps it", async () => {
  claudeLoginStart();
  let ep = tokenEndpoint(() => ok({ access_token: "first", refresh_token: "rt-1", expires_in: 60 }));
  try {
    await claudeLoginComplete("code");
  } finally {
    ep.restore();
  }
  // 60 s of life is inside the 5 min skew, so the next read must refresh rather than hand back a
  // token that expires mid-request.
  ep = tokenEndpoint(() => ok({ access_token: "second", expires_in: 28_800 }));
  try {
    assert.equal(await loadClaudeToken(), "second");
    assert.equal(ep.calls[0]!.body["grant_type"], "refresh_token");
    assert.equal(ep.calls[0]!.body["refresh_token"], "rt-1");
  } finally {
    ep.restore();
  }
  // The refreshed credential was persisted, so a second read costs no network call at all.
  ep = tokenEndpoint(() => ok({ access_token: "third", expires_in: 28_800 }));
  try {
    assert.equal(await loadClaudeToken(), "second");
    assert.equal(ep.calls.length, 0);
  } finally {
    ep.restore();
  }
  // And the omitted rotation token was kept: refreshing again still authenticates.
  await setStoredExpiryInThePast();
  ep = tokenEndpoint(() => ok({ access_token: "fourth", expires_in: 28_800 }));
  try {
    assert.equal(await loadClaudeToken(), "fourth");
    assert.equal(ep.calls[0]!.body["refresh_token"], "rt-1");
  } finally {
    ep.restore();
  }
});

test("concurrent reads collapse into one refresh", async () => {
  claudeLoginStart();
  let ep = tokenEndpoint(() => ok({ access_token: "first", refresh_token: "rt-1", expires_in: 60 }));
  try {
    await claudeLoginComplete("code");
  } finally {
    ep.restore();
  }
  ep = tokenEndpoint(() => ok({ access_token: "shared", expires_in: 28_800 }));
  try {
    const all = await Promise.all([loadClaudeToken(), loadClaudeToken(), loadClaudeToken()]);
    assert.deepEqual(all, ["shared", "shared", "shared"]);
    // A rotated refresh token used twice is how an account gets locked out.
    assert.equal(ep.calls.length, 1);
  } finally {
    ep.restore();
  }
});

test("a failed refresh degrades to the long-lived token instead of stopping the run", async () => {
  await setClaudeToken("sk-ant-oat-long-lived");
  claudeLoginStart();
  let ep = tokenEndpoint(() => ok({ access_token: "first", refresh_token: "rt-1", expires_in: 60 }));
  try {
    await claudeLoginComplete("code");
  } finally {
    ep.restore();
  }
  const st = await claudeTokenStatus();
  assert.equal(st.source, "oauth");
  assert.equal(st.hasFallbackToken, true);

  ep = tokenEndpoint(() => new Response("upstream is down", { status: 503 }));
  try {
    assert.equal(await loadClaudeToken(), "sk-ant-oat-long-lived");
  } finally {
    ep.restore();
  }
});

test("pasting a long-lived token clears the OAuth credential, so the paste is what takes effect", async () => {
  claudeLoginStart();
  const ep = tokenEndpoint(() => ok({ access_token: "oauth-access", refresh_token: "rt", expires_in: 28_800 }));
  try {
    await claudeLoginComplete("code");
  } finally {
    ep.restore();
  }
  await setClaudeToken("sk-ant-oat-pasted");
  assert.equal(await loadClaudeToken(), "sk-ant-oat-pasted");
  assert.equal((await claudeTokenStatus()).source, "my-claw");
});
