import type { ApprovalDecision, ToolApprovalRequest } from "../channels/types.ts";

/**
 * The surface an explicit `approval` request needs, injected by the channel that can draw it.
 *
 * The automatic gates reach the owner through the run's approval handler, which the bridge owns.
 * The tool is different: it has no gate to open, so it asks through here, and the adapter answers
 * with the same sheet, the same page and the same journal as everything else. Kept separate rather
 * than exported from the channel because `tools/` must not import `channels/`.
 */
export interface PendingApprovalView {
  id: string;
  toolName: string;
  args: Record<string, unknown>;
  /** `local` or the node's display name, resolved by the surface. */
  origin: string;
  /** The sentence the agent wrote, when it asked by itself. */
  headline?: string;
  since: string;
  waitForever: boolean;
}

export interface ApprovalSurface {
  /** Raises the prompt and waits for the owner. `waitForever` is skipped: asking by hand means waiting. */
  ask(request: ToolApprovalRequest): Promise<ApprovalDecision>;
  /** Everything still waiting for this owner, across every conversation and machine. */
  pending(owner: string): PendingApprovalView[];
}

let surface: ApprovalSurface | undefined;

export function setApprovalSurface(next: ApprovalSurface | undefined): void {
  surface = next;
}

export function hasApprovalSurface(): boolean {
  return surface !== undefined;
}

/**
 * The agent asking for permission before it acts. No timer: the run is waiting on a person, and a
 * timeout would answer "no" on his behalf (owner, 2026-11-05).
 */
export async function askOwner(request: ToolApprovalRequest): Promise<ApprovalDecision> {
  if (!surface) return "deny";
  return await surface.ask({ ...request, waitForever: true });
}

export function pendingApprovals(owner: string): PendingApprovalView[] {
  return surface?.pending(owner) ?? [];
}
