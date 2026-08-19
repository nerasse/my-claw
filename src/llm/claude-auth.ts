import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { MY_CLAW_DIR } from "../core/config.ts";
import { writeFileAtomically } from "../utils/atomic-write.ts";
import { log } from "../utils/logger.ts";
import { CLAUDE_USER_AGENT } from "./anthropic-release.ts";

// The Claude subscription credentials. Two kinds live here, in one 0600 file:
//   - `oauth`: access + refresh from the PKCE flow below, access valid ~8 h, refreshed in place;
//   - `token`: the long-lived token `claude setup-token` prints (~1 year, no refresh).
// Stored in a my-claw-owned file so it survives restarts and the SDK backend can inject it per
// run, independent of the systemd EnvironmentFile / ~/.my-claw/.env split. See
// docs/claude-sdk-backend.md and docs/anthropic-backend.md.
const AUTH_PATH = join(MY_CLAW_DIR, "claude", "auth.json");
const TOKEN_ENV = "CLAUDE_CODE_OAUTH_TOKEN";
// setup-token prints an "sk-ant-oat..." token; capture it defensively from mixed output.
const TOKEN_PATTERN = /sk-ant-[A-Za-z0-9._-]+/;

// Read out of the shipped CLI (2.1.206), not out of a community plugin: the client id and both
// endpoints are present verbatim in the bundle. The scope list is what a real Claude Code login was
// actually granted, read off `~/.claude/.credentials.json`, which is stronger evidence than the
// bundle's concatenated string table: it carries `user:file_upload` too. `org:create_api_key` is
// left out, it exists to mint an API key and step outside the subscription.
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const AUTHORIZE_URL = "https://platform.claude.com/oauth/authorize";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
// The CLI's own flow redirects to a localhost listener. That needs a browser on the same host, so
// this uses the manual variant the same page serves (`code=true`): Anthropic displays the code and
// the owner pastes it back, which is the only shape a chat channel can drive.
const CODE_CALLBACK_URL = "https://platform.claude.com/oauth/code/callback";
const SCOPES = "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";

// Refresh this far ahead of expiry, so a request never races the clock it just checked.
const REFRESH_SKEW_MS = 5 * 60 * 1000;
// A started login is remembered in memory only: the verifier is single-use secret material with no
// reason to touch the disk, and a restart mid-login costs one `/claude login`.
const PENDING_TTL_MS = 10 * 60 * 1000;

export interface ClaudeOAuthCredential {
  access: string;
  refresh: string;
  /** Absolute epoch ms, as stored. `expires_in` is relative to a response we no longer hold. */
  expires: number;
}

interface ClaudeAuthFile {
  token?: string;
  oauth?: ClaudeOAuthCredential;
}

async function readAuthFile(): Promise<ClaudeAuthFile> {
  try {
    const raw = await readFile(AUTH_PATH, "utf-8");
    return JSON.parse(raw) as ClaudeAuthFile;
  } catch {
    return {};
  }
}

async function writeAuthFile(file: ClaudeAuthFile): Promise<void> {
  await writeFileAtomically(AUTH_PATH, JSON.stringify(file, null, 2), { mode: 0o600 });
}

async function readStoredToken(): Promise<string | null> {
  const file = await readAuthFile();
  return file.token && file.token.length > 0 ? file.token : null;
}

/**
 * A bearer token for the Claude subscription, refreshed when it is about to expire.
 *
 * Order: the OAuth credential, then the long-lived token, then the ambient env one. The fallback
 * runs on a *failed* refresh too, and that is the point of keeping both: a refresh outage degrades
 * to the one-year token instead of stopping every run.
 */
export async function loadClaudeToken(): Promise<string | null> {
  const file = await readAuthFile();
  if (file.oauth) {
    try {
      return await validAccessToken(file.oauth);
    } catch (err) {
      void log("warn", "claude oauth refresh failed, falling back to the stored token", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (file.token) return file.token;
  return process.env[TOKEN_ENV] ?? null;
}

/**
 * The ambient token, read synchronously. Availability is decided on a read path that cannot await
 * a file, so it works from a periodic sample -- and a token rotated in `.env` alone never reaches
 * that sample: the watcher refreshes `process.env` but returns before announcing anything, having
 * found no config section changed. Runs would then work while the picker called the model
 * unauthenticated. This is the half of the answer that needs no sampling at all.
 */
export function claudeTokenInEnv(): boolean {
  return Boolean(process.env[TOKEN_ENV]);
}

/**
 * Store a pasted long-lived token. It clears the OAuth credential on purpose: pasting a token is
 * an explicit choice of which authentication to use, and leaving a credential that outranks it
 * would make the paste look like it did nothing.
 */
export async function setClaudeToken(token: string): Promise<void> {
  const trimmed = token.trim();
  if (!trimmed) throw new Error("empty token");
  await writeAuthFile({ token: trimmed });
}

export async function clearClaudeToken(): Promise<void> {
  await writeFileAtomically(AUTH_PATH, "{}", { mode: 0o600 }).catch(() => {});
}

export interface ClaudeTokenStatus {
  present: boolean;
  source: "oauth" | "my-claw" | "env" | "none";
  masked?: string;
  /** Minutes until the OAuth access token expires. Negative once it has, which is recoverable. */
  expiresInMin?: number;
  /** A long-lived token is stored behind the OAuth credential, so a refresh outage is survivable. */
  hasFallbackToken?: boolean;
}

function mask(token: string): string {
  return token.length <= 14 ? "set" : `${token.slice(0, 10)}…${token.slice(-4)}`;
}

export async function claudeTokenStatus(): Promise<ClaudeTokenStatus> {
  const file = await readAuthFile();
  if (file.oauth) {
    return {
      present: true,
      source: "oauth",
      masked: mask(file.oauth.access),
      expiresInMin: Math.round((file.oauth.expires - Date.now()) / 60_000),
      hasFallbackToken: Boolean(file.token),
    };
  }
  if (file.token) return { present: true, source: "my-claw", masked: mask(file.token) };
  const env = process.env[TOKEN_ENV];
  if (env) return { present: true, source: "env", masked: mask(env) };
  return { present: false, source: "none" };
}

// ============================================================================
// OAuth: PKCE authorization code with a pasted code, and refresh
// ============================================================================

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
}

async function postToken(body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "user-agent": CLAUDE_USER_AGENT,
    },
    body: JSON.stringify({ ...body, client_id: CLIENT_ID }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Claude OAuth request failed (${res.status}): ${text || res.statusText}`);
  }
  return (await res.json()) as TokenResponse;
}

/**
 * A rotation that omits the new refresh token keeps the old one working, so dropping it on an
 * omission would throw away the only way back in. Measured by both community plugins before us.
 */
function credentialFrom(json: TokenResponse, previousRefresh: string): ClaudeOAuthCredential {
  if (!json.access_token) throw new Error("Claude OAuth response carried no access token");
  return {
    access: json.access_token,
    refresh: json.refresh_token ?? previousRefresh,
    expires: Date.now() + (json.expires_in ?? 8 * 3600) * 1000,
  };
}

let refreshInFlight: Promise<ClaudeOAuthCredential> | null = null;

/**
 * The access token of a credential, refreshed when it is inside the skew. One in-process guard
 * collapses concurrent refreshes: my-claw is a single process, and a rotated refresh token used
 * twice is the documented way to get locked out.
 */
async function validAccessToken(cred: ClaudeOAuthCredential): Promise<string> {
  if (Date.now() < cred.expires - REFRESH_SKEW_MS) return cred.access;
  if (!refreshInFlight) {
    refreshInFlight = postToken({ grant_type: "refresh_token", refresh_token: cred.refresh })
      .then(async (json) => {
        const next = credentialFrom(json, cred.refresh);
        const file = await readAuthFile();
        await writeAuthFile({ ...file, oauth: next });
        void log("info", "claude token refreshed", { expiresInSec: Math.round((next.expires - Date.now()) / 1000) });
        return next;
      })
      .finally(() => {
        refreshInFlight = null;
      });
  }
  return (await refreshInFlight).access;
}

function base64url(buf: Buffer): string {
  return buf.toString("base64url");
}

interface PendingLogin {
  verifier: string;
  state: string;
  startedAt: number;
}

let pending: PendingLogin | null = null;

/**
 * Start a login: returns the URL to open. The verifier stays in memory until the code comes back,
 * which is what makes the exchange provable to Anthropic and unusable by anyone who only sees the
 * URL.
 */
export function claudeLoginStart(): { url: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  const state = randomUUID().replace(/-/g, "");
  pending = { verifier, state, startedAt: Date.now() };

  const url = new URL(AUTHORIZE_URL);
  // `code=true` is what makes the callback page display the code instead of posting it back.
  url.searchParams.set("code", "true");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", CODE_CALLBACK_URL);
  url.searchParams.set("scope", SCOPES);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  return { url: url.toString() };
}

/**
 * Accepts what Anthropic's page actually gives, in the three shapes it comes back as: the full
 * redirect URL, the `code#state` pair the page shows for pasting, or a bare code. A bare code is
 * checked against the state we generated; a pasted one must match it.
 */
function parseCode(input: string): { code: string; state?: string } | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (code) return { code, ...(state ? { state } : {}) };
  } catch {
    // Not a URL, fall through to the pasted forms.
  }
  const hash = trimmed.split("#");
  if (hash.length === 2 && hash[0] && hash[1]) return { code: hash[0], state: hash[1] };
  const params = new URLSearchParams(trimmed);
  const code = params.get("code");
  if (code) return { code, ...(params.get("state") ? { state: params.get("state")! } : {}) };
  return /\s/.test(trimmed) ? null : { code: trimmed };
}

/**
 * Finish a login with the code from the callback page. Keeps any long-lived token already stored:
 * it becomes the fallback for a refresh outage.
 */
export async function claudeLoginComplete(input: string): Promise<{ expiresInMin: number }> {
  if (!pending) throw new Error("No login in progress. Start one with /claude login.");
  if (Date.now() - pending.startedAt > PENDING_TTL_MS) {
    pending = null;
    throw new Error("Login expired. Start a new one with /claude login.");
  }
  const parsed = parseCode(input);
  if (!parsed) throw new Error("Could not read a code in what you sent.");
  if (parsed.state && parsed.state !== pending.state) {
    throw new Error("State mismatch: this code belongs to another login attempt.");
  }
  const json = await postToken({
    grant_type: "authorization_code",
    code: parsed.code,
    state: pending.state,
    redirect_uri: CODE_CALLBACK_URL,
    code_verifier: pending.verifier,
  });
  if (!json.refresh_token) throw new Error("Claude OAuth response carried no refresh token");
  const cred = credentialFrom(json, json.refresh_token);
  const file = await readAuthFile();
  await writeAuthFile({ ...file, oauth: cred });
  pending = null;
  return { expiresInMin: Math.round((cred.expires - Date.now()) / 60_000) };
}

/** True while a started login is still within its window, so the chat can name the next step. */
export function claudeLoginPending(): boolean {
  return pending !== null && Date.now() - pending.startedAt <= PENDING_TTL_MS;
}

/** Test seam: both are module state shared by every test file. */
export function resetClaudeAuthState(): void {
  pending = null;
  refreshInFlight = null;
}

/**
 * Run the official `claude setup-token`, capture the printed token and store it. Terminal-only:
 * the underlying tool needs a browser and a TTY.
 *
 * Kept next to `claudeLoginStart`, which does not need either: this one mints the long-lived token
 * that backs the OAuth credential when a refresh fails, and it is the only path that does not
 * require my-claw to hold a refresh token at all.
 */
export function runClaudeSetupToken(): Promise<{ ok: boolean; token?: string; message: string }> {
  return new Promise((resolve) => {
    let out = "";
    let child;
    try {
      child = spawn("claude", ["setup-token"], { stdio: ["inherit", "pipe", "inherit"] });
    } catch (err) {
      resolve({ ok: false, message: `Could not run 'claude setup-token': ${err instanceof Error ? err.message : String(err)}` });
      return;
    }
    child.stdout?.on("data", (d: Buffer) => {
      const s = d.toString();
      out += s;
      process.stdout.write(s);
    });
    child.on("error", (err: Error) => {
      resolve({ ok: false, message: `Could not run 'claude setup-token': ${err.message}. Is the Claude CLI installed and on PATH?` });
    });
    child.on("close", async () => {
      const match = out.match(TOKEN_PATTERN);
      if (!match) {
        resolve({ ok: false, message: "No token detected in 'claude setup-token' output. Copy it and run: my-claw claude set-token <token>" });
        return;
      }
      try {
        await setClaudeToken(match[0]);
        resolve({ ok: true, token: match[0], message: "Claude token stored in ~/.my-claw/claude/auth.json." });
      } catch (err) {
        resolve({ ok: false, message: `Failed to store token: ${err instanceof Error ? err.message : String(err)}` });
      }
    });
  });
}
