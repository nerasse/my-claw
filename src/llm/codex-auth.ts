import { log } from "../utils/logger.ts";
import { accountKeys, readAccount, removeAccount, writeAccount } from "./accounts-store.ts";

// Public OAuth client id of the official `codex` CLI. Using it is what lets a ChatGPT
// Plus/Pro subscription drive the Codex backend without a per-token API key.
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTH_BASE_URL = "https://auth.openai.com";
const TOKEN_URL = `${AUTH_BASE_URL}/oauth/token`;
const DEVICE_USER_CODE_URL = `${AUTH_BASE_URL}/api/accounts/deviceauth/usercode`;
const DEVICE_TOKEN_URL = `${AUTH_BASE_URL}/api/accounts/deviceauth/token`;
const DEVICE_VERIFICATION_URI = `${AUTH_BASE_URL}/codex/device`;
const DEVICE_REDIRECT_URI = `${AUTH_BASE_URL}/deviceauth/callback`;
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
const PROFILE_CLAIM_PATH = "https://api.openai.com/profile";

const DEVICE_CODE_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 5000;
const MIN_POLL_INTERVAL_MS = 1000;
const SLOW_DOWN_INCREMENT_MS = 5000;
// Refresh a little before expiry so an in-flight request never races the deadline.
const REFRESH_SKEW_MS = 60_000;

export const CODEX_BASE_URL = "https://chatgpt.com/backend-api";

export interface CodexCredential {
  access: string;
  refresh: string;
  /** Absolute epoch ms when the access token expires. */
  expires: number;
  accountId: string;
}

export interface DeviceCodePrompt {
  userCode: string;
  verificationUri: string;
  expiresInSeconds: number;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
}

function decodeJwtClaim(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    // JWT payloads are base64url; atob wants base64 and rejects url chars.
    const b64 = parts[1]!.replace(/-/g, "+").replace(/_/g, "/");
    const json = atob(b64);
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function accountIdFromToken(accessToken: string): string | null {
  const payload = decodeJwtClaim(accessToken);
  const auth = payload?.[JWT_CLAIM_PATH];
  if (auth && typeof auth === "object") {
    const id = (auth as { chatgpt_account_id?: unknown }).chatgpt_account_id;
    if (typeof id === "string" && id.length > 0) return id;
  }
  return null;
}

function credentialFromTokenResponse(json: TokenResponse): CodexCredential {
  if (!json.access_token || !json.refresh_token || typeof json.expires_in !== "number") {
    throw new Error(`Codex token response missing fields: ${JSON.stringify(json)}`);
  }
  const accountId = accountIdFromToken(json.access_token);
  if (!accountId) throw new Error("Codex access token has no chatgpt_account_id claim");
  return {
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + json.expires_in * 1000,
    accountId,
  };
}

/**
 * Refuses a ChatGPT sign-in whose email is already connected on another provider: the device code
 * can be approved in a browser signed in to the other account, and the opaque tokens would never
 * say so. The email rides in the access token, so the check costs no request.
 */
async function assertCodexIdentityFree(provider: string, cred: CodexCredential): Promise<void> {
  const email = decodeJwtClaim(cred.access)?.[PROFILE_CLAIM_PATH];
  const want = typeof email === "string" && email ? email.trim().toLowerCase() : undefined;
  if (!want) return;
  for (const key of await accountKeys()) {
    if (key === provider) continue;
    const other = await readAccount<Partial<CodexCredential>>(key);
    if (!other?.access) continue;
    const otherEmail = decodeJwtClaim(other.access)?.[PROFILE_CLAIM_PATH];
    if (typeof otherEmail === "string" && otherEmail.trim().toLowerCase() === want) {
      throw new Error(`This account (${email}) is already connected on provider "${key}". Sign it out there first.`);
    }
  }
}

// ============================================================================
// Persistence
// ============================================================================

// No in-memory cache: login happens in a separate short-lived CLI process, so the running
// service must read the file fresh to pick up a first login or a re-login without a restart. The
// file is tiny; a read per LLM request is negligible next to the request itself.
async function readCredential(provider: string): Promise<CodexCredential | null> {
  const parsed = await readAccount<Partial<CodexCredential>>(provider);
  if (parsed?.access && parsed.refresh && typeof parsed.expires === "number" && parsed.accountId) {
    return { access: parsed.access, refresh: parsed.refresh, expires: parsed.expires, accountId: parsed.accountId };
  }
  return null;
}

async function writeCredential(provider: string, cred: CodexCredential): Promise<void> {
  await writeAccount(provider, cred);
}

export async function loadCodexCredential(provider: string): Promise<CodexCredential | null> {
  return readCredential(provider);
}

export async function codexLogout(provider: string): Promise<void> {
  await removeAccount(provider).catch(() => {});
}

/** True when a stored credential exists (independent of whether it is currently expired). */
export async function codexIsLoggedIn(provider: string): Promise<boolean> {
  return (await readCredential(provider)) !== null;
}

// ============================================================================
// Token exchange / refresh
// ============================================================================

async function postForm(url: string, body: Record<string, string>, signal?: AbortSignal): Promise<TokenResponse> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Codex OAuth request failed (${res.status}): ${text || res.statusText}`);
  }
  return (await res.json()) as TokenResponse;
}

async function refreshCredential(refreshToken: string): Promise<CodexCredential> {
  const json = await postForm(TOKEN_URL, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
  });
  return credentialFromTokenResponse(json);
}

const refreshInFlight = new Map<string, Promise<CodexCredential>>();

/**
 * Return a valid access token + account id for a Codex request, refreshing (and persisting the
 * rotated refresh token) when the stored token is within the expiry skew. A single in-process
 * guard collapses concurrent refreshes — my-claw runs one process, so no cross-process lock.
 */
export async function getCodexAccessToken(
  provider: string,
  signal?: AbortSignal,
): Promise<{ accessToken: string; accountId: string }> {
  const cred = await readCredential(provider);
  if (!cred) {
    throw new Error(`Provider "${provider}" is not signed in to ChatGPT. Sign in from Settings → Models.`);
  }
  if (Date.now() < cred.expires - REFRESH_SKEW_MS) {
    return { accessToken: cred.access, accountId: cred.accountId };
  }
  let inFlight = refreshInFlight.get(provider);
  if (!inFlight) {
    inFlight = refreshCredential(cred.refresh)
      .then(async (next) => {
        await writeCredential(provider, next);
        void log("info", "codex token refreshed", { provider, expiresInSec: Math.round((next.expires - Date.now()) / 1000) });
        return next;
      })
      .finally(() => {
        refreshInFlight.delete(provider);
      });
    refreshInFlight.set(provider, inFlight);
  }
  const refreshed = await inFlight;
  if (signal?.aborted) throw new Error("aborted");
  return { accessToken: refreshed.access, accountId: refreshed.accountId };
}

// ============================================================================
// Device-code login
// ============================================================================

interface DeviceAuth {
  deviceAuthId: string;
  userCode: string;
  intervalMs: number;
}

async function startDeviceAuth(signal?: AbortSignal): Promise<DeviceAuth> {
  const res = await fetch(DEVICE_USER_CODE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: CLIENT_ID }),
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Codex device code request failed (${res.status}): ${text || res.statusText}`);
  }
  const json = (await res.json()) as { device_auth_id?: string; user_code?: string; interval?: number | string };
  const intervalRaw = typeof json.interval === "string" ? Number(json.interval) : json.interval;
  if (!json.device_auth_id || !json.user_code) {
    throw new Error(`Invalid Codex device code response: ${JSON.stringify(json)}`);
  }
  const intervalMs = Number.isFinite(intervalRaw) && (intervalRaw as number) > 0
    ? Math.max(MIN_POLL_INTERVAL_MS, (intervalRaw as number) * 1000)
    : DEFAULT_POLL_INTERVAL_MS;
  return { deviceAuthId: json.device_auth_id, userCode: json.user_code, intervalMs };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("aborted")); }, { once: true });
  });
}

async function pollDeviceAuth(device: DeviceAuth, signal?: AbortSignal): Promise<{ authorizationCode: string; codeVerifier: string }> {
  const deadline = Date.now() + DEVICE_CODE_TIMEOUT_MS;
  let intervalMs = device.intervalMs;
  while (Date.now() < deadline) {
    await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())), signal);
    const res = await fetch(DEVICE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_auth_id: device.deviceAuthId, user_code: device.userCode }),
      signal,
    });
    if (res.ok) {
      const json = (await res.json()) as { authorization_code?: string; code_verifier?: string };
      if (!json.authorization_code || !json.code_verifier) {
        throw new Error(`Invalid Codex device token response: ${JSON.stringify(json)}`);
      }
      return { authorizationCode: json.authorization_code, codeVerifier: json.code_verifier };
    }
    // 403/404 = user has not completed the approval yet; keep polling.
    if (res.status === 403 || res.status === 404) continue;
    const text = await res.text().catch(() => "");
    let code: unknown;
    try {
      const j = JSON.parse(text) as { error?: string | { code?: string } };
      code = typeof j.error === "object" ? j.error?.code : j.error;
    } catch {
      // non-JSON error body
    }
    if (code === "deviceauth_authorization_pending") continue;
    if (code === "slow_down") {
      intervalMs += SLOW_DOWN_INCREMENT_MS;
      continue;
    }
    throw new Error(`Codex device auth failed (${res.status}): ${text || res.statusText}`);
  }
  throw new Error("Codex device authorization timed out");
}

/**
 * Run the OAuth device-code login. `onPrompt` receives the user code + verification URL to show
 * (console for the CLI, or a chat message later). Persists the resulting credential on success.
 */
export async function codexLoginDeviceCode(
  provider: string,
  onPrompt: (prompt: DeviceCodePrompt) => void,
  signal?: AbortSignal,
): Promise<CodexCredential> {
  const device = await startDeviceAuth(signal);
  onPrompt({
    userCode: device.userCode,
    verificationUri: DEVICE_VERIFICATION_URI,
    expiresInSeconds: Math.round(DEVICE_CODE_TIMEOUT_MS / 1000),
  });
  const { authorizationCode, codeVerifier } = await pollDeviceAuth(device, signal);
  const json = await postForm(TOKEN_URL, {
    grant_type: "authorization_code",
    code: authorizationCode,
    code_verifier: codeVerifier,
    redirect_uri: DEVICE_REDIRECT_URI,
    client_id: CLIENT_ID,
  }, signal);
  const cred = credentialFromTokenResponse(json);
  await assertCodexIdentityFree(provider, cred);
  await writeCredential(provider, cred);
  return cred;
}
