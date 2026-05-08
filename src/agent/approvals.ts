import type { SessionData } from "../sessions/store.ts";
import type { ToolApprovalHandler, ToolApprovalRequest } from "../channels/types.ts";
import { ActionBlacklist } from "./blacklist.ts";

export type ApprovalDecision = "allow-once" | "allow-session" | "deny";

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
    if (!this.blacklist.requiresConfirmation(params.request.toolName)) {
      return "allow-once";
    }

    const approvedTools = params.session.approvedTools ?? [];
    if (approvedTools.includes(params.request.toolName)) {
      return "allow-session";
    }

    if (!this.approvalHandler) {
      return "deny";
    }

    const decision = await this.approvalHandler(params.request);
    if (decision === "allow-session") {
      params.session.approvedTools = [...approvedTools, params.request.toolName];
    }
    return decision;
  }
}
