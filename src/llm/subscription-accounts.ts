import { codexLoginDeviceCode, codexLogout, loadCodexCredential, type DeviceCodePrompt } from "./codex-auth.ts";
import { claudeLoginComplete, claudeLoginStart, claudeTokenStatus, clearClaudeToken, setClaudeToken } from "./claude-auth.ts";

// The ChatGPT and Claude subscriptions, signed in from the app's Accounts page rather than with
// `/codex` and `/claude` (docs/subscription-accounts.md). Same token stores, same provider
// bootstrap (`onAuthChanged`); what this adds is the state a page needs: a sign-in in flight,
// with what to show for it, survives the page being closed and reopened.

export type AccountKind = "codex" | "claude";

/** A sign-in in flight: the page to open and, for ChatGPT, the code to enter there. */
export interface AccountLogin {
  url: string;
  code?: string;
  expiresAt: number;
}

export interface AccountView {
  connected: boolean;
  email?: string;
  plan?: string;
  /** Claude only: a sign-in that renews itself, a long-lived token, or one from the server's env. */
  source?: "oauth" | "token" | "env";
  login?: AccountLogin;
}

export interface AccountsState {
  codex: AccountView;
  claude: AccountView;
}

export interface AccountsDeps {
  /** Adds the provider if missing, re-samples the auth and re-runs discovery (index.ts). */
  onAuthChanged: (kind: AccountKind) => Promise<void>;
  /** A ChatGPT sign-in ends minutes after it started: its outcome is pushed, not answered. */
  onSettled: (state: AccountsState, error?: string) => void;
}

const CLAUDE_LOGIN_TTL_MS = 10 * 60 * 1000;
// What OpenAI writes in the access token: the plan and the address of the account it belongs to.
const AUTH_CLAIM = "https://api.openai.com/auth";
const PROFILE_CLAIM = "https://api.openai.com/profile";

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

export interface AccountsController {
  status(): Promise<AccountsState>;
  login(kind: AccountKind): Promise<AccountsState>;
  cancel(kind: AccountKind): Promise<AccountsState>;
  /** Claude: the code its page shows once the owner approved. */
  code(input: string): Promise<AccountsState>;
  /** Claude: a long-lived token from `claude setup-token`. */
  token(token: string): Promise<AccountsState>;
  logout(kind: AccountKind): Promise<AccountsState>;
}

export function createAccounts(deps: AccountsDeps): AccountsController {
  let codexLogin: { view: AccountLogin; abort: AbortController } | null = null;
  let claudeLogin: AccountLogin | null = null;

  const live = (login: AccountLogin | null): AccountLogin | undefined =>
    login && login.expiresAt > Date.now() ? login : undefined;

  const status = async (): Promise<AccountsState> => {
    const cred = await loadCodexCredential();
    const claims = cred ? claimsOf(cred.access) : {};
    const email = field(claims[PROFILE_CLAIM], "email");
    const plan = field(claims[AUTH_CLAIM], "chatgpt_plan_type");
    const codexLive = live(codexLogin?.view ?? null);
    const claude = await claudeTokenStatus();
    const claudeLive = live(claudeLogin);
    return {
      codex: { connected: cred !== null, ...(email ? { email } : {}), ...(plan ? { plan } : {}), ...(codexLive ? { login: codexLive } : {}) },
      claude: {
        connected: claude.present,
        ...(claude.present ? { source: claude.source === "my-claw" ? "token" : claude.source === "env" ? "env" : "oauth" } : {}),
        ...(claudeLive ? { login: claudeLive } : {}),
      },
    };
  };

  const startCodex = async (): Promise<void> => {
    if (live(codexLogin?.view ?? null)) return;
    codexLogin?.abort.abort();
    const abort = new AbortController();
    const prompt = await new Promise<DeviceCodePrompt>((resolve, reject) => {
      let prompted = false;
      codexLoginDeviceCode((p) => {
        prompted = true;
        resolve(p);
      }, abort.signal)
        .then(async () => {
          if (codexLogin?.abort === abort) codexLogin = null;
          await deps.onAuthChanged("codex");
          deps.onSettled(await status());
        })
        .catch(async (err: unknown) => {
          if (!prompted) return reject(err);
          if (codexLogin?.abort === abort) codexLogin = null;
          // A cancel is the owner's own doing: the page already shows it, nothing to report.
          if (abort.signal.aborted) return;
          deps.onSettled(await status(), err instanceof Error ? err.message : String(err));
        });
    });
    codexLogin = {
      abort,
      view: { url: prompt.verificationUri, code: prompt.userCode, expiresAt: Date.now() + prompt.expiresInSeconds * 1000 },
    };
  };

  return {
    status,
    async login(kind) {
      if (kind === "codex") await startCodex();
      else claudeLogin = { url: claudeLoginStart().url, expiresAt: Date.now() + CLAUDE_LOGIN_TTL_MS };
      return status();
    },
    async cancel(kind) {
      if (kind === "codex") {
        codexLogin?.abort.abort();
        codexLogin = null;
      } else {
        claudeLogin = null;
      }
      return status();
    },
    async code(input) {
      await claudeLoginComplete(input);
      claudeLogin = null;
      await deps.onAuthChanged("claude");
      return status();
    },
    async token(token) {
      await setClaudeToken(token.trim());
      await deps.onAuthChanged("claude");
      return status();
    },
    async logout(kind) {
      if (kind === "codex") {
        codexLogin?.abort.abort();
        codexLogin = null;
        await codexLogout();
      } else {
        claudeLogin = null;
        await clearClaudeToken();
      }
      await deps.onAuthChanged(kind);
      return status();
    },
  };
}
