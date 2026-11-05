import type { Tool, ToolResult } from "./types.ts";
import { strOpt } from "./types.ts";
import type { UnifiedMessage } from "../channels/types.ts";
import { askOwner, hasApprovalSurface, pendingApprovals } from "../approvals/ask.ts";
import { rethrowIfAborted } from "../core/aborted.ts";

/**
 * The agent asking the owner for permission, and reading what is already waiting.
 *
 * Two actions in one tool on purpose: they are the same subject from two sides (my run is blocked,
 * another run is blocked), and a second tool for a one-line listing would cost every prompt a
 * definition for nothing.
 *
 * `request` waits with no timer. This is the one path where the run means to wait: the agent chose
 * to ask, so a timeout would be the machine answering "no" for the owner. Stop cancels it, and a
 * message typed into the conversation cancels it the way a question is cancelled.
 */
export function createApprovalTool(): Tool {
  return {
    name: "approval",
    description: [
      "Ask the owner before doing something risky or irreversible, and see what is already waiting on him.",
      "action=request: raises the approval sheet with your sentence and the exact call, then the run waits -- no timeout, until he answers, stops the run or types. Returns approved, approved-always (he allowed this exact call for good), denied or cancelled.",
      "action=list: everything still waiting for an answer, across every conversation and machine, so you can tell a blocked sub-agent from a hung one.",
      "Ask once per decision, not once per step: a shell command that needs a yes does not need a second yes for the check after it. Never ask for something you would not do if he said no.",
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["request", "list"], description: "request = ask and wait; list = what is waiting." },
        what: { type: "string", description: "request: one sentence, what you are about to do and why it needs a yes." },
        tool: { type: "string", description: "request: the tool you will run (default bash when command is given)." },
        command: { type: "string", description: "request: the exact bash command. It is what \"always allow this exact call\" matches." },
        args: { type: "object", description: "request: the exact arguments of the call, when they are not a bash command." },
      },
      required: ["action"],
    },
    async execute(args): Promise<ToolResult> {
      const action = strOpt(args, "action") ?? "request";
      const message = args["__message"] as UnifiedMessage | undefined;
      const signal = args["__signal"] as AbortSignal | undefined;
      const owner = message?.chatId ?? "";
      const sessionId = typeof args["__sessionId"] === "string" ? args["__sessionId"] : "";

      if (action === "list") {
        const waiting = pendingApprovals(owner);
        if (waiting.length === 0) return { success: true, output: "Nothing is waiting for approval." };
        const lines = waiting.map((entry) => {
          const detail = summaryOf(entry.args);
          return `- ${entry.id} · ${entry.origin} · ${entry.toolName}${detail ? `: ${detail}` : ""} · waiting since ${entry.since}${entry.waitForever ? " (no timeout)" : ""}`;
        });
        return { success: true, output: `${waiting.length} waiting:\n${lines.join("\n")}` };
      }

      if (action !== "request") {
        return { success: false, output: "", error: `approval: unknown action "${action}"` };
      }
      if (!hasApprovalSurface()) return { success: false, output: "", error: "No channel surface to ask for approval on" };

      const what = (strOpt(args, "what") ?? "").trim();
      if (!what) return { success: false, output: "", error: "approval: what is required for a request" };
      const command = strOpt(args, "command");
      const callArgs = command !== undefined ? { command } : (args["args"] as Record<string, unknown> | undefined) ?? {};
      const toolName = strOpt(args, "tool") ?? (command !== undefined ? "bash" : "action");

      try {
        const decision = await askOwner({
          id: `ask-${crypto.randomUUID()}`,
          platform: message?.platform ?? "my-claw-app",
          chatId: owner,
          userId: message?.userId ?? "",
          chatType: message?.chatType ?? "dm",
          messageId: message?.id ?? "",
          sessionId,
          toolName,
          args: callArgs,
          ...(message?.threadId ? { threadId: message.threadId } : {}),
          ...(typeof args["__toolCallId"] === "string" ? { replyToId: args["__toolCallId"] } : {}),
          headline: what,
        });
        if (signal?.aborted) rethrowIfAborted(new Error("aborted"), signal);
        switch (decision) {
          case "allow-always":
            return { success: true, output: "approved-always: the owner allowed this exact call for good on this machine. Run it now." };
          case "allow-session":
          case "allow-once":
            return { success: true, output: "approved: the owner said yes. Run it now." };
          default:
            return { success: true, output: "denied: the owner said no. Do not run it, and do not ask again for the same thing." };
        }
      } catch (err) {
        rethrowIfAborted(err, signal);
        return { success: false, output: "", error: String(err) };
      }
    },
  };
}

/** The argument that says what the pending call is about, for the one-line listing. */
function summaryOf(args: Record<string, unknown>): string {
  const key = ["command", "path", "url", "pattern"].find((name) => typeof args[name] === "string" && (args[name] as string).trim().length > 0);
  return key ? (args[key] as string).trim().slice(0, 160) : "";
}
