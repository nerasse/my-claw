import type { SessionData } from "../sessions/store.ts";
import type { ApprovalDecision, ToolApprovalHandler, ToolApprovalRequest } from "../channels/types.ts";
import { ActionBlacklist } from "./blacklist.ts";

const ALWAYS_PER_INVOCATION = new Set(["bash", "memory"]);

// Tools that always require approval regardless of user blacklist config.
// memory: LLM writes to MEMORY.md which persists in the system prompt across sessions.
const FORCED_APPROVAL = new Set(["memory"]);

export class ToolApprovalManager {
  private blacklist: ActionBlacklist;

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

    const decision = await this.approvalHandler(params.request);
    if (decision === "allow-session" && !ALWAYS_PER_INVOCATION.has(params.request.toolName)) {
      const approvedTools = params.session.approvedTools ?? [];
      params.session.approvedTools = [...approvedTools, params.request.toolName];
    }
    return decision;
  }
}
