import type { LlmProviderConfig } from "../core/config.ts";
import { codexLoginDeviceCode, codexLogout, loadCodexCredential, type DeviceCodePrompt } from "./codex-auth.ts";
import { claudeLoginComplete, claudeLoginStart, claudeTokenStatus, clearClaudeToken, ensureClaudeProfile, setClaudeToken } from "./claude-auth.ts";
import { subscriptionProviders, type AccountKind } from "./accounts-store.ts";

// The ChatGPT and Claude plans, signed in from the app (docs/subscription-accounts.md). A plan is a
// provider like any other: each one holds its own sign-in, so the owner can have several of a kind
// and name them. What this adds over the token stores is the state a page needs: a sign-in in
// flight, with what to show for it, survives the page being closed and reopened.

export type { AccountKind };

export interface AccountLogin {
  url: string;
  code?: string;
  expiresAt: number;
}

export interface AccountView {
  /** The provider key: what the models are addressed by, and the name of the sign-in's file. */
  provider: string;
  kind: AccountKind;
  /** The owner's name for it (the provider's `group`), the key when none was given. */
  name: string;
  connected: boolean;
  email?: string;
  plan?: string;
  source?: "oauth" | "token";
  /** The organization the account belongs to, when the profile named one. */
  org?: string;
  login?: AccountLogin;
}

/**
 * `codex` and `claude` are the first account of each kind, in the shape an app older than 0.6.129
 * reads: without them that page throws on the missing field, between the server's update and the
 * APK's. The current app reads `accounts`.
 */
export interface AccountsState {
  accounts: AccountView[];
  codex: LegacyView;
  claude: LegacyView;
}

interface LegacyView {
  connected: boolean;
  email?: string;
  plan?: string;
  source?: "oauth" | "token";
  login?: AccountLogin;
}

export interface AccountsDeps {
  /** The live providers: an account is a provider the config declares. */
  providers: () => Record<string, LlmProviderConfig> | undefined;
  /** Declares a new provider of that kind under that key and name, and reloads the config. */
  addProvider: (key: string, kind: AccountKind, name: string) => Promise<void>;
  renameProvider: (key: string, name: string) => Promise<void>;
  onAuthChanged: (provider: string) => Promise<void>;
  onSettled: (state: AccountsState, error?: string) => void;
}

const CLAUDE_LOGIN_TTL_MS = 10 * 60 * 1000;
// What OpenAI writes in the access token: the plan and the address of the account it belongs to.
const AUTH_CLAIM = "https://api.openai.com/auth";
const PROFILE_CLAIM = "https://api.openai.com/profile";
const NAME_MAX = 40;

function claimsOf(token: string): Record<string, unknown> {
  try {
    return JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function field(claim: unknown, key: string): string | undefined {
  const value = claim && typeof claim === "object" ? (claim as Record<string, unknown>)[key] : undefined;
  return typeof value === "string" && value ? value : undefined;
}

/**
 * The key a new account gets: the kind's short base (`claude`, `chatgpt`), numbered when taken.
 * The key is the account's id -- it names the sign-in file and prefixes every model reference --
 * so it stays short and never follows the owner's name, which is free to change whenever (`group`
 * is the name). A reference like `claude-2/claude-opus-5-5` is what a session pins; the name only
 * reads in the picker and on the Accounts page (docs/subscription-accounts.md).
 */
export function accountKeyFor(kind: AccountKind, taken: ReadonlySet<string>): string {
  const base = kind === "codex" ? "chatgpt" : "claude";
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

export interface AccountsController {
  status(): Promise<AccountsState>;
  login(provider: string): Promise<AccountsState>;
  cancel(provider: string): Promise<AccountsState>;
  code(provider: string, input: string): Promise<AccountsState>;
  token(provider: string, token: string): Promise<AccountsState>;
  logout(provider: string): Promise<AccountsState>;
  add(kind: AccountKind, name: string): Promise<AccountsState & { added: string }>;
  rename(provider: string, name: string): Promise<AccountsState>;
}

export function createAccounts(deps: AccountsDeps): AccountsController {
  const codexLogins = new Map<string, { view: AccountLogin; abort: AbortController }>();
  // One Claude sign-in at a time: claude-auth keeps a single verifier, so starting a second one
  // makes the first page's code useless, and only the second page shows a login.
  let claudeLogin: { provider: string; view: AccountLogin } | null = null;

  const live = (login: AccountLogin | undefined): AccountLogin | undefined =>
    login && login.expiresAt > Date.now() ? login : undefined;

  const accountOf = (provider: string) => {
    const account = subscriptionProviders(deps.providers()).find((a) => a.key === provider);
    if (!account) throw new Error(`No ChatGPT or Claude account named "${provider}".`);
    return account;
  };

  const viewOf = async (account: { key: string; kind: AccountKind; name: string }): Promise<AccountView> => {
    const base = { provider: account.key, kind: account.kind, name: account.name };
    if (account.kind === "codex") {
      const cred = await loadCodexCredential(account.key);
      const claims = cred ? claimsOf(cred.access) : {};
      const email = field(claims[PROFILE_CLAIM], "email");
      const plan = field(claims[AUTH_CLAIM], "chatgpt_plan_type");
      const login = live(codexLogins.get(account.key)?.view);
      return { ...base, connected: cred !== null, ...(email ? { email } : {}), ...(plan ? { plan } : {}), ...(login ? { login } : {}) };
    }
    const claude = await claudeTokenStatus(account.key);
    // Who it is, not just that it is: with two accounts of one kind the sign-in alone says
    // nothing, and an approval made in the wrong browser tab is invisible without the email.
    const profile = claude.present && !claude.profile ? await ensureClaudeProfile(account.key).catch(() => null) : null;
    const email = claude.profile?.email ?? profile?.email;
    const login = claudeLogin?.provider === account.key ? live(claudeLogin.view) : undefined;
    return {
      ...base,
      connected: claude.present,
      ...(email ? { email } : {}),
      ...(claude.profile?.org ? { org: claude.profile.org } : {}),
      ...(claude.present ? { source: claude.source === "my-claw" ? ("token" as const) : ("oauth" as const) } : {}),
      ...(login ? { login } : {}),
    };
  };

  const legacy = (views: AccountView[], kind: AccountKind): LegacyView => {
    const first = views.find((v) => v.kind === kind);
    if (!first) return { connected: false };
    const { provider: _p, kind: _k, name: _n, ...rest } = first;
    return rest;
  };

  const status = async (): Promise<AccountsState> => {
    const accounts = await Promise.all(subscriptionProviders(deps.providers()).map(viewOf));
    return { accounts, codex: legacy(accounts, "codex"), claude: legacy(accounts, "claude") };
  };

  const startCodex = async (provider: string): Promise<void> => {
    if (live(codexLogins.get(provider)?.view)) return;
    codexLogins.get(provider)?.abort.abort();
    const abort = new AbortController();
    const prompt = await new Promise<DeviceCodePrompt>((resolve, reject) => {
      let prompted = false;
      codexLoginDeviceCode(provider, (p) => {
        prompted = true;
        resolve(p);
      }, abort.signal)
        .then(async () => {
          if (codexLogins.get(provider)?.abort === abort) codexLogins.delete(provider);
          await deps.onAuthChanged(provider);
          deps.onSettled(await status());
        })
        .catch(async (err: unknown) => {
          if (!prompted) return reject(err);
          if (codexLogins.get(provider)?.abort === abort) codexLogins.delete(provider);
          // A cancel is the owner's own doing: the page already shows it, nothing to report.
          if (abort.signal.aborted) return;
          deps.onSettled(await status(), err instanceof Error ? err.message : String(err));
        });
    });
    codexLogins.set(provider, {
      abort,
      view: { url: prompt.verificationUri, code: prompt.userCode, expiresAt: Date.now() + prompt.expiresInSeconds * 1000 },
    });
  };

  const claudeOnly = (provider: string): void => {
    if (accountOf(provider).kind !== "claude") throw new Error("A code or a token is for a Claude account.");
  };

  return {
    status,
    async login(provider) {
      const { kind } = accountOf(provider);
      if (kind === "codex") await startCodex(provider);
      else claudeLogin = { provider, view: { url: claudeLoginStart(provider).url, expiresAt: Date.now() + CLAUDE_LOGIN_TTL_MS } };
      return status();
    },
    async cancel(provider) {
      codexLogins.get(provider)?.abort.abort();
      codexLogins.delete(provider);
      if (claudeLogin?.provider === provider) claudeLogin = null;
      return status();
    },
    async code(provider, input) {
      claudeOnly(provider);
      await claudeLoginComplete(provider, input);
      claudeLogin = null;
      await deps.onAuthChanged(provider);
      return status();
    },
    async token(provider, token) {
      claudeOnly(provider);
      await setClaudeToken(provider, token.trim());
      await deps.onAuthChanged(provider);
      return status();
    },
    async logout(provider) {
      const { kind } = accountOf(provider);
      codexLogins.get(provider)?.abort.abort();
      codexLogins.delete(provider);
      if (claudeLogin?.provider === provider) claudeLogin = null;
      if (kind === "codex") await codexLogout(provider);
      else await clearClaudeToken(provider);
      await deps.onAuthChanged(provider);
      return status();
    },
    async add(kind, name) {
      const trimmed = name.trim().slice(0, NAME_MAX);
      const key = accountKeyFor(kind, new Set(Object.keys(deps.providers() ?? {})));
      await deps.addProvider(key, kind, trimmed || key);
      return { ...(await status()), added: key };
    },
    async rename(provider, name) {
      accountOf(provider);
      const trimmed = name.trim().slice(0, NAME_MAX);
      if (!trimmed) throw new Error("A name cannot be empty.");
      await deps.renameProvider(provider, trimmed);
      return status();
    },
  };
}
