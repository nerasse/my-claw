import type { SessionData } from "../sessions/store.ts";
import type { ApprovalDecision, ToolApprovalHandler, ToolApprovalRequest } from "../channels/types.ts";
import { ActionBlacklist } from "./blacklist.ts";

const ALWAYS_PER_INVOCATION = new Set(["bash", "memory"]);

// Tools that always require approval regardless of user blacklist config.
// memory: LLM writes to MEMORY.md which persists in the system prompt across sessions.
const FORCED_APPROVAL = new Set(["memory"]);

export class ToolApprovalManager {
  private blacklist: ActionBlacklist;
  // Concurrent approval prompts for the same tool+session are coalesced into one, so a
  // parallel batch (e.g. 3 spawns at once) asks the user once instead of N times.
  private pendingApprovals = new Map<string, Promise<ApprovalDecision>>();

  constructor(
    blacklistedActions: string[],
    private approvalHandler?: ToolApprovalHandler,
  ) {
    this.blacklist = new ActionBlacklist(blacklistedActions);
  }

  setHandler(handler: ToolApprovalHandler | undefined): void {
    this.approvalHandler = handler;
  }

  async decide(params: {
    session: SessionData;
    request: ToolApprovalRequest;
  }): Promise<ApprovalDecision> {
    const needsConfirmation =
      this.blacklist.requiresConfirmation(params.request.toolName) ||
      FORCED_APPROVAL.has(params.request.toolName);
    if (!needsConfirmation) {
      return "allow-once";
    }

    if (!ALWAYS_PER_INVOCATION.has(params.request.toolName)) {
      const approvedTools = params.session.approvedTools ?? [];
      if (approvedTools.includes(params.request.toolName)) {
        return "allow-session";
      }
    }

    if (!this.approvalHandler) {
      return "deny";
    }

    // Per-invocation tools (bash, memory) must be reviewed one by one — never coalesce.
    if (ALWAYS_PER_INVOCATION.has(params.request.toolName)) {
      return await this.approvalHandler(params.request);
    }

    // Coalesce concurrent prompts for the same tool in the same session: firing N identical
    // prompts and requiring N answers is a footgun — unanswered ones time out and kill the
    // whole batch. One decision covers every in-flight call of that tool.
    const key = `${params.session.id}::${params.request.toolName}`;
    let inflight = this.pendingApprovals.get(key);
    if (!inflight) {
      inflight = Promise.resolve(this.approvalHandler(params.request)).finally(() => {
        this.pendingApprovals.delete(key);
      });
      this.pendingApprovals.set(key, inflight);
    }
    const decision = await inflight;
    if (decision === "allow-session") {
      const approvedTools = params.session.approvedTools ?? [];
      if (!approvedTools.includes(params.request.toolName)) {
        params.session.approvedTools = [...approvedTools, params.request.toolName];
      }
    }
    return decision;
  }
}
