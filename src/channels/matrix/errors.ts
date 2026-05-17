export type MatrixErrorPolicy = "always" | "once" | "silent";

export interface MatrixErrorPolicyConfig {
  mode: MatrixErrorPolicy;
  onceCooldownMs: number;
}

const MAX_ERROR_ENTRIES = 500;

const USER_FACING_MESSAGES: Record<string, string> = {
  rate_limit: "Rate limited. Please wait a moment and try again.",
  network_error: "Network error. Please try again.",
  matrix_forbidden: "Permission denied. The bot may lack access to this room.",
  matrix_error: "Something went wrong while processing your message. Please try again.",
  unknown: "An unexpected error occurred. Please try again.",
};

export function matrixUserFacingError(errorKey: string): string {
  return USER_FACING_MESSAGES[errorKey] ?? USER_FACING_MESSAGES["unknown"]!;
}

export class MatrixErrorReporter {
  private lastShown = new Map<string, number>();

  constructor(private config: MatrixErrorPolicyConfig) {}

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
    if (err instanceof Error) {
      const message = err.message.toLowerCase();
      if (message.includes("m_forbidden") || message.includes("forbidden")) {
        return "matrix_forbidden";
      }
      if (message.includes("m_limit_exceeded") || message.includes("rate")) {
        return "rate_limit";
      }
      if (message.includes("network") || message.includes("fetch") || message.includes("timeout")) {
        return "network_error";
      }
      return "matrix_error";
    }

    return "unknown";
  }
}
