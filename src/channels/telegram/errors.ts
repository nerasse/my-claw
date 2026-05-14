import { GrammyError, HttpError } from "grammy";

export type ErrorPolicy = "always" | "once" | "silent";

export interface ErrorPolicyConfig {
  mode: ErrorPolicy;
  onceCooldownMs: number;
}

const PARSE_ERR_RE = /can't parse entities|parse entities|find end of the entity/i;

const MAX_ERROR_ENTRIES = 500;

export class ErrorReporter {
  private lastShown = new Map<string, number>();

  constructor(private config: ErrorPolicyConfig) {}

  shouldReport(errorKey: string): boolean {
    if (this.config.mode === "silent") return false;
    if (this.config.mode === "always") return true;

    this.pruneExpired();

    const now = Date.now();
    const lastShown = this.lastShown.get(errorKey);
    if (lastShown !== undefined && now - lastShown < this.config.onceCooldownMs) {
      return false;
    }

    this.lastShown.set(errorKey, now);
    return true;
  }

  private pruneExpired(): void {
    if (this.lastShown.size <= MAX_ERROR_ENTRIES) return;
    const now = Date.now();
    for (const [key, ts] of this.lastShown) {
      if (now - ts > this.config.onceCooldownMs) {
        this.lastShown.delete(key);
      }
    }
  }

  errorKey(err: unknown): string {
    if (err instanceof GrammyError) {
      if (err.error_code === 429) return "rate_limit";
      if (PARSE_ERR_RE.test(err.description)) return "parse_error";
      return `telegram_${err.error_code}`;
    }

    if (err instanceof HttpError) {
      const code = (err.error as { code?: unknown } | undefined)?.code;
      return typeof code === "string" ? `network_${code}` : "network_error";
    }

    if (err instanceof Error) {
      if (/rate limit|too many requests|429/i.test(err.message)) return "rate_limit";
      return "agent_error";
    }

    return "unknown";
  }
}
