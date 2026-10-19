import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { log } from "../utils/logger.ts";
import { accountKeys, readAccount, removeAccount, writeAccount } from "./accounts-store.ts";
import { claudeUserAgent } from "./anthropic-release.ts";

// The Claude subscription credentials, one 0600 file per provider (accounts-store.ts). Two kinds:
//   - `oauth`: access + refresh from the PKCE flow below, access valid ~8 h, refreshed in place;
//   - `token`: the long-lived token `claude setup-token` prints (~1 year, no refresh).
// Stored in a my-claw-owned file so it survives restarts and the native Anthropic transport can
// inject it per run, independent of the systemd EnvironmentFile / ~/.my-claw/.env split. See
// docs/anthropic-backend.md.
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
  /** Who the sign-in actually is, read from the token (see fetchClaudeProfile). */
  profile?: ClaudeProfile;
}

/**
 * The account behind an access token. The PKCE flow never says which account was approved -- an
 * approval in a browser signed in to the other Claude account is invisible -- so this is what
 * makes "which account is this?" answerable, and what lets a second sign-in of the same email be
 * refused (docs/subscription-accounts.md).
 */
export interface ClaudeProfile {
  email?: string;
  name?: string;
  org?: string;
  checkedAt: number;
}

const PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
const OAUTH_BETA = "oauth-2025-04-20";
const PROFILE_TIMEOUT_MS = 10_000;

/** The one call that turns a sign-in into a name. Throws on a refused call (a 401 is a bad token). */
export async function fetchClaudeProfile(access: string): Promise<ClaudeProfile> {
  const res = await fetch(PROFILE_URL, {
    headers: { authorization: `Bearer ${access}`, "anthropic-beta": OAUTH_BETA, "user-agent": claudeUserAgent() },
    signal: AbortSignal.timeout(PROFILE_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Claude profile request failed (${res.status})`);
  const json = (await res.json().catch(() => null)) as
    | { account?: { email?: unknown; full_name?: unknown }; organization?: { name?: unknown } }
    | null;
  const email = json?.account?.email;
  const name = json?.account?.full_name;
  const org = json?.organization?.name;
  return {
    ...(typeof email === "string" && email ? { email } : {}),
    ...(typeof name === "string" && name ? { name } : {}),
    ...(typeof org === "string" && org ? { org } : {}),
    checkedAt: Date.now(),
  };
}

/**
 * Refuses a sign-in whose email is already connected on another provider. With two accounts of
 * one kind, approving the page in a browser signed in to the other account silently binds the
 * wrong identity; no downstream code could tell, since the tokens are opaque. The email is the
 * only signal that exists, and it exists before anything is written.
 */
async function assertClaudeIdentityFree(provider: string, profile: ClaudeProfile): Promise<void> {
  if (!profile.email) return;
  const want = profile.email.trim().toLowerCase();
  for (const key of await accountKeys()) {
    if (key === provider) continue;
    const other = await readAccount<ClaudeAuthFile>(key);
    const email = other?.profile?.email?.trim().toLowerCase();
    if (email && email === want) {
      throw new Error(`This account (${profile.email}) is already connected on provider "${key}". Sign it out there first.`);
    }
  }
}

async function readAuthFile(provider: string): Promise<ClaudeAuthFile> {
  return (await readAccount<ClaudeAuthFile>(provider)) ?? {};
}

async function writeAuthFile(provider: string, file: ClaudeAuthFile): Promise<void> {
  await writeAccount(provider, file);
}

/**
 * A bearer token for the Claude subscription, refreshed when it is about to expire.
 *
 * Order: the OAuth credential, then the long-lived token, then the ambient env one. The fallback
 * runs on a *failed* refresh too, and that is the point of keeping both: a refresh outage degrades
 * to the one-year token instead of stopping every run.
 */
export async function loadClaudeToken(provider: string): Promise<string | null> {
  const file = await readAuthFile(provider);
  if (file.oauth) {
    try {
      return await validAccessToken(provider, file.oauth);
    } catch (err) {
      void log("warn", "claude oauth refresh failed, falling back to the stored token", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return file.token ?? null;
}

/**
 * Store a pasted long-lived token. It clears the OAuth credential on purpose: pasting a token is
 * an explicit choice of which authentication to use, and leaving a credential that outranks it
 * would make the paste look like it did nothing. The identity is read first: a 401 refuses the
 * token itself, and the profile is what the duplicate-account check runs on.
 */
export async function setClaudeToken(provider: string, token: string): Promise<void> {
  const trimmed = token.trim();
  if (!trimmed) throw new Error("empty token");
  let profile: ClaudeProfile | null = null;
  try {
    profile = await fetchClaudeProfile(trimmed);
  } catch (err) {
    if (/\b40[13]\b/.test(String(err))) throw new Error("Anthropic refused this token.");
  }
  if (profile) await assertClaudeIdentityFree(provider, profile);
  const file = await readAuthFile(provider);
  const kept = profile ?? file.profile;
  await writeAuthFile(provider, { ...(kept ? { profile: kept } : {}), token: trimmed });
}

export async function clearClaudeToken(provider: string): Promise<void> {
  await removeAccount(provider).catch(() => {});
}

export interface ClaudeTokenStatus {
  present: boolean;
  source: "oauth" | "my-claw" | "none";
  masked?: string;
  /** Minutes until the OAuth access token expires. Negative once it has, which is recoverable. */
  expiresInMin?: number;
  /** A long-lived token is stored behind the OAuth credential, so a refresh outage is survivable. */
  hasFallbackToken?: boolean;
  /** Who the account is, when it has been read. The Accounts page shows it. */
  profile?: { email?: string; name?: string; org?: string };
}

function mask(token: string): string {
  return token.length <= 14 ? "set" : `${token.slice(0, 10)}…${token.slice(-4)}`;
}

export async function claudeTokenStatus(provider: string): Promise<ClaudeTokenStatus> {
  const file = await readAuthFile(provider);
  const profile = file.profile ? { ...(file.profile.email ? { email: file.profile.email } : {}), ...(file.profile.name ? { name: file.profile.name } : {}), ...(file.profile.org ? { org: file.profile.org } : {}) } : undefined;
  if (file.oauth) {
    return {
      present: true,
      source: "oauth",
      masked: mask(file.oauth.access),
      expiresInMin: Math.round((file.oauth.expires - Date.now()) / 60_000),
      hasFallbackToken: Boolean(file.token),
      ...(profile ? { profile } : {}),
    };
  }
  if (file.token) return { present: true, source: "my-claw", masked: mask(file.token), ...(profile ? { profile } : {}) };
  return { present: false, source: "none" };
}

const profileAttemptAt = new Map<string, number>();
const PROFILE_RETRY_MS = 60_000;

/**
 * Best-effort fill-in of a stored profile that predates this feature: read the token and call the
 * profile endpoint, at most once a minute per provider. A failure answers null and changes
 * nothing -- an offline box must not turn "connected" into an error page.
 */
export async function ensureClaudeProfile(provider: string): Promise<ClaudeProfile | null> {
  const file = await readAuthFile(provider);
  if (file.profile) return file.profile;
  const last = profileAttemptAt.get(provider) ?? 0;
  if (Date.now() - last < PROFILE_RETRY_MS) return null;
  profileAttemptAt.set(provider, Date.now());
  const token = file.oauth
    ? await validAccessToken(provider, file.oauth).catch(() => file.token ?? null)
    : file.token ?? null;
  if (!token) return null;
  try {
    const profile = await fetchClaudeProfile(token);
    await writeAuthFile(provider, { ...file, profile });
    return profile;
  } catch {
    return null;
  }
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
      "user-agent": claudeUserAgent(),
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

const refreshInFlight = new Map<string, Promise<ClaudeOAuthCredential>>();

/**
 * The access token of a credential, refreshed when it is inside the skew. One in-process guard
 * collapses concurrent refreshes: my-claw is a single process, and a rotated refresh token used
 * twice is the documented way to get locked out.
 */
async function validAccessToken(provider: string, cred: ClaudeOAuthCredential): Promise<string> {
  if (Date.now() < cred.expires - REFRESH_SKEW_MS) return cred.access;
  let inFlight = refreshInFlight.get(provider);
  if (!inFlight) {
    inFlight = postToken({ grant_type: "refresh_token", refresh_token: cred.refresh })
      .then(async (json) => {
        const next = credentialFrom(json, cred.refresh);
        const file = await readAuthFile(provider);
        await writeAuthFile(provider, { ...file, oauth: next });
        void log("info", "claude token refreshed", { provider, expiresInSec: Math.round((next.expires - Date.now()) / 1000) });
        return next;
      })
      .finally(() => {
        refreshInFlight.delete(provider);
      });
    refreshInFlight.set(provider, inFlight);
  }
  return (await inFlight).access;
}

function base64url(buf: Buffer): string {
  return buf.toString("base64url");
}

interface PendingLogin {
  provider: string;
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
export function claudeLoginStart(provider: string): { url: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  const state = randomUUID().replace(/-/g, "");
  pending = { provider, verifier, state, startedAt: Date.now() };

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
export async function claudeLoginComplete(provider: string, input: string): Promise<{ expiresInMin: number }> {
  // The verifier belongs to the provider it was started for: a code pasted on another account's
  // page must not sign that one in with this one's identity.
  if (!pending || pending.provider !== provider) throw new Error("No login in progress. Start one with /claude login.");
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
  // Read who the sign-in is before it lands anywhere: a profile call that fails (offline) must not
  // block a sign-in, but a readable email that is already connected elsewhere must.
  const profile = await fetchClaudeProfile(cred.access).catch(() => null);
  if (profile) await assertClaudeIdentityFree(provider, profile);
  const file = await readAuthFile(provider);
  await writeAuthFile(provider, { ...file, oauth: cred, ...(profile ? { profile } : {}) });
  pending = null;
  return { expiresInMin: Math.round((cred.expires - Date.now()) / 60_000) };
}

/** True while a started login is still within its window, so the chat can name the next step. */
export function claudeLoginPending(provider: string): boolean {
  return pending !== null && pending.provider === provider && Date.now() - pending.startedAt <= PENDING_TTL_MS;
}

/** Test seam: both are module state shared by every test file. */
export function resetClaudeAuthState(): void {
  pending = null;
  refreshInFlight.clear();
  profileAttemptAt.clear();
}

/**
 * Run the official `claude setup-token`, capture the printed token and store it. Terminal-only:
 * the underlying tool needs a browser and a TTY.
 *
 * Kept next to `claudeLoginStart`, which does not need either: this one mints the long-lived token
 * that backs the OAuth credential when a refresh fails, and it is the only path that does not
 * require my-claw to hold a refresh token at all.
 */
export function runClaudeSetupToken(provider: string): Promise<{ ok: boolean; token?: string; message: string }> {
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
        await setClaudeToken(provider, match[0]);
        resolve({ ok: true, token: match[0], message: `Claude token stored in ~/.my-claw/accounts/${provider}.json.` });
      } catch (err) {
        resolve({ ok: false, message: `Failed to store token: ${err instanceof Error ? err.message : String(err)}` });
      }
    });
  });
}
