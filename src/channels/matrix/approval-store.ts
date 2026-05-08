import type { ApprovalDecision, ToolApprovalRequest } from "../types.ts";

const DEFAULT_APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

type PendingMatrixApproval = {
  request: ToolApprovalRequest;
  resolve: (decision: ApprovalDecision) => void;
  expiresAt: number;
  timer?: ReturnType<typeof setTimeout>;
};

export type PersistedPendingMatrixApproval = {
  request: ToolApprovalRequest;
  expiresAt: number;
};

const pendingApprovals = new Map<string, PendingMatrixApproval>();

export function createMatrixApprovalStore(
  timeoutMs = DEFAULT_APPROVAL_TIMEOUT_MS,
  options?: { unrefTimers?: boolean },
) {
  const pendingApprovals = new Map<string, PendingMatrixApproval>();
  const armTimer = (id: string, expiresAt: number, resolve: (decision: ApprovalDecision) => void) => {
    const delayMs = Math.max(1, expiresAt - Date.now());
    return setTimeout(() => {
      const pending = pendingApprovals.get(id);
      if (!pending) return;
      pendingApprovals.delete(id);
      pending.resolve("deny");
    }, delayMs);
  };

  return {
    async request(request: ToolApprovalRequest): Promise<ApprovalDecision> {
      return await new Promise<ApprovalDecision>((resolve) => {
        const expiresAt = Date.now() + timeoutMs;
        const timer = armTimer(request.id, expiresAt, resolve);
        if (options?.unrefTimers === true) {
          timer.unref?.();
        }
        pendingApprovals.set(request.id, {
          request,
          resolve,
          expiresAt,
          timer,
        });
      });
    },

    resolve(id: string, decision: ApprovalDecision): { request: ToolApprovalRequest; expired: boolean } | null {
      const pending = pendingApprovals.get(id);
      if (!pending) return null;
      pendingApprovals.delete(id);
      if (pending.timer) clearTimeout(pending.timer);
      const expired = pending.expiresAt < Date.now();
      pending.resolve(expired ? "deny" : decision);
      return {
        request: pending.request,
        expired,
      };
    },

    cancel(id: string): boolean {
      const pending = pendingApprovals.get(id);
      if (!pending) return false;
      pendingApprovals.delete(id);
      if (pending.timer) clearTimeout(pending.timer);
      pending.resolve("deny");
      return true;
    },

    peek(id: string): ToolApprovalRequest | null {
      return pendingApprovals.get(id)?.request ?? null;
    },

    snapshot(): PersistedPendingMatrixApproval[] {
      const now = Date.now();
      return [...pendingApprovals.values()]
        .filter((pending) => pending.expiresAt > now)
        .map((pending) => ({ request: pending.request, expiresAt: pending.expiresAt }));
    },

    restore(entries: PersistedPendingMatrixApproval[]): void {
      for (const entry of entries) {
        if (!entry) {
          continue;
        }
        pendingApprovals.set(entry.request.id, {
          request: entry.request,
          resolve: () => undefined,
          expiresAt: 0,
        });
      }
    },

    clear(): void {
      for (const pending of pendingApprovals.values()) {
        if (pending.timer) {
          clearTimeout(pending.timer);
        }
      }
      pendingApprovals.clear();
    },
  };
}
