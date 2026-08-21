import type { SessionData } from "../sessions/store.ts";
import type { ApprovalDecision, ToolApprovalHandler, ToolApprovalRequest } from "../channels/types.ts";
import { ActionBlacklist } from "./blacklist.ts";
import { recordApproval, serializeArgs } from "../approvals/store.ts";

// Approval is strictly opt-in via config.blacklist — full autonomy by design (the app
// runs in its own encapsulated VM). These two are only special IF the user blacklists
// them: they are then re-confirmed on every call (never session-cached), because each
// bash command / memory write is a distinct decision.
export const ALWAYS_PER_INVOCATION: ReadonlySet<string> = new Set(["bash", "memory"]);

/** Never lets an audit failure break a tool call: the journal is a record, not a gate. */
function journal(record: Parameters<typeof recordApproval>[0]): void {
  try {
    recordApproval(record);
  } catch {
    // Logged by the channel on the interactive path; here the run must simply carry on.
  }
}

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

  private journalAuto(request: ToolApprovalRequest): void {
    const at = new Date().toISOString();
    journal({
      id: `auto:${crypto.randomUUID()}`,
      owner: request.chatId,
      threadId: request.threadId ?? "default",
      sessionId: request.sessionId,
      toolName: request.toolName,
      args: serializeArgs(request.args),
      outcome: "allow-session",
      requestedAt: at,
      decidedAt: at,
      durationMs: 0,
      auto: true,
    });
  }

  async decide(params: {
    session: SessionData;
    request: ToolApprovalRequest;
  }): Promise<ApprovalDecision> {
    if (!this.blacklist.requiresConfirmation(params.request.toolName)) {
      return "allow-once";
    }

    if (!ALWAYS_PER_INVOCATION.has(params.request.toolName)) {
      const approvedTools = params.session.approvedTools ?? [];
      if (approvedTools.includes(params.request.toolName)) {
        // Journalled too, and flagged `auto`: a session grant means later calls run with nothing
        // on screen, so this branch is precisely the one an audit needs to see.
        this.journalAuto(params.request);
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
