import { readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { MY_CLAW_DIR, type LlmProviderConfig } from "../core/config.ts";
import { writeFileAtomically } from "../utils/atomic-write.ts";
import { removeEnvKey } from "../core/env-edit.ts";
import { log } from "../utils/logger.ts";

/**
 * A subscription is a provider like any other, and each one holds its own sign-in: two ChatGPT
 * accounts are two providers, each with its file (docs/subscription-accounts.md). The file is named
 * after the provider key, so a sign-in can never be read by another provider.
 */

export type AccountKind = "codex" | "claude";

const ACCOUNTS_DIR = join(MY_CLAW_DIR, "accounts");
/** Where the one-per-server sign-ins lived before 0.7.86, adopted once by the first provider. */
const LEGACY_CODEX = join(MY_CLAW_DIR, "codex", "auth.json");
const LEGACY_CLAUDE = join(MY_CLAW_DIR, "claude", "auth.json");
export const CLAUDE_TOKEN_ENV = "CLAUDE_CODE_OAUTH_TOKEN";

const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function accountPath(provider: string): string {
  // The key names a file: anything that could walk out of the directory is refused, not escaped.
  if (!KEY_RE.test(provider)) throw new Error(`Invalid provider key for an account: ${provider}`);
  return join(ACCOUNTS_DIR, `${provider}.json`);
}

/**
 * Which sign-in a provider holds, from its declaration alone: `codex` is always a ChatGPT plan; an
 * `anthropic` provider is the Claude plan when it brings neither a key nor an address of its own.
 */
export function accountKindOf(provider: Pick<LlmProviderConfig, "type" | "apiKeyEnv" | "baseUrl">): AccountKind | null {
  if (provider.type === "codex") return "codex";
  if (provider.type === "anthropic" && !provider.apiKeyEnv && !provider.baseUrl) return "claude";
  return null;
}

export function subscriptionProviders(
  providers: Record<string, LlmProviderConfig> | undefined,
): Array<{ key: string; kind: AccountKind; name: string }> {
  const out: Array<{ key: string; kind: AccountKind; name: string }> = [];
  for (const [key, provider] of Object.entries(providers ?? {})) {
    const kind = accountKindOf(provider);
    if (kind) out.push({ key, kind, name: provider.group || key });
  }
  return out;
}

export async function readAccount<T>(provider: string): Promise<T | null> {
  try {
    const parsed = JSON.parse(await readFile(accountPath(provider), "utf-8")) as unknown;
    return parsed && typeof parsed === "object" && Object.keys(parsed).length > 0 ? (parsed as T) : null;
  } catch {
    return null;
  }
}

export async function writeAccount(provider: string, data: object): Promise<void> {
  await writeFileAtomically(accountPath(provider), JSON.stringify(data, null, 2), { mode: 0o600 });
}

export async function removeAccount(provider: string): Promise<void> {
  await rm(accountPath(provider), { force: true });
}

/** A provider renamed keeps its sign-in: the file follows the key. */
export async function moveAccount(from: string, to: string): Promise<void> {
  await rename(accountPath(from), accountPath(to)).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== "ENOENT") throw err;
  });
}

async function exists(path: string): Promise<boolean> {
  return readFile(path).then(() => true, () => false);
}

/**
 * The sign-ins of before, each given to the first provider of its kind that has none yet, then
 * gone from where they were: one source per account. The Claude token of `.env` is adopted the same
 * way and its line removed, so a Sign out is a sign out (owner, 2026-10-04). Run at boot and when
 * `.env` changes: a token pasted there later is adopted then.
 */
export async function adoptLegacyAccounts(providers: Record<string, LlmProviderConfig> | undefined): Promise<void> {
  const subs = subscriptionProviders(providers);
  const firstOf = (kind: AccountKind): string | undefined => subs.find((s) => s.kind === kind)?.key;

  const codex = firstOf("codex");
  if (codex && !(await readAccount(codex)) && (await exists(LEGACY_CODEX))) {
    await rename(LEGACY_CODEX, accountPath(codex)).catch(async () => {
      await writeAccount(codex, JSON.parse(await readFile(LEGACY_CODEX, "utf-8")) as object);
      await rm(LEGACY_CODEX, { force: true });
    });
    void log("info", "chatgpt sign-in adopted by its provider", { provider: codex });
  }

  const claude = firstOf("claude");
  if (!claude) return;
  if (!(await readAccount(claude)) && (await exists(LEGACY_CLAUDE))) {
    const legacy = JSON.parse(await readFile(LEGACY_CLAUDE, "utf-8").catch(() => "{}")) as object;
    if (Object.keys(legacy).length > 0) await writeAccount(claude, legacy);
    await rm(LEGACY_CLAUDE, { force: true });
    if (Object.keys(legacy).length > 0) void log("info", "claude sign-in adopted by its provider", { provider: claude });
  }
  const envToken = process.env[CLAUDE_TOKEN_ENV];
  if (!envToken) return;
  // An account already signed in keeps its sign-in; the env line is dropped either way, or it
  // would come back as a second source the next time someone signs out.
  if (!(await readAccount(claude))) {
    await writeAccount(claude, { token: envToken.trim() });
    void log("info", "claude token of .env adopted by its provider", { provider: claude });
  }
  const removed = await removeEnvKey(CLAUDE_TOKEN_ENV);
  if (removed.ok) delete process.env[CLAUDE_TOKEN_ENV];
  else void log("warn", "could not remove the claude token from .env", { error: removed.error });
}
