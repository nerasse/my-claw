import type { ApprovalDecision, ToolApprovalRequest } from "../types.ts";

const DEFAULT_APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

type PendingMatrixApproval = {
  request: ToolApprovalRequest;
  resolve: (decision: ApprovalDecision) => void;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
};

const pendingApprovals = new Map<string, PendingMatrixApproval>();

export function createMatrixApprovalStore(timeoutMs = DEFAULT_APPROVAL_TIMEOUT_MS) {
  return {
    async request(request: ToolApprovalRequest): Promise<ApprovalDecision> {
      return await new Promise<ApprovalDecision>((resolve) => {
        const timer = setTimeout(() => {
          const pending = pendingApprovals.get(request.id);
          if (!pending) return;
          pendingApprovals.delete(request.id);
          pending.resolve("deny");
        }, timeoutMs);
        pendingApprovals.set(request.id, {
          request,
          resolve,
          expiresAt: Date.now() + timeoutMs,
          timer,
        });
      });
    },

    resolve(id: string, decision: ApprovalDecision): { request: ToolApprovalRequest; expired: boolean } | null {
      const pending = pendingApprovals.get(id);
      if (!pending) return null;
      pendingApprovals.delete(id);
      clearTimeout(pending.timer);
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
      clearTimeout(pending.timer);
      pending.resolve("deny");
      return true;
    },

    peek(id: string): ToolApprovalRequest | null {
      return pendingApprovals.get(id)?.request ?? null;
    },
  };
}
