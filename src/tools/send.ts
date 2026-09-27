import { type Tool, type ToolResult, str } from "./types.ts";
import { resumeHint, SubAgentRunner, type SubAgentStream } from "../subagents/runner.ts";
import { SubAgentRegistry } from "../subagents/registry.ts";
import type { UnifiedMessage, Attachment } from "../channels/types.ts";
import { isAbort, rethrowIfAborted } from "../core/aborted.ts";

export function createSendTool(
  runner: SubAgentRunner,
  registry: SubAgentRegistry,
  streamProvider?: (subagentId: string) => SubAgentStream | undefined,
): Tool {
  return {
    name: "send",
    description: "Send a message to an existing sub-agent. The sub-agent loads its full session history, processes the message, and saves the updated session. Blocks if the sub-agent is already running. Leave the message out to resume a sub-agent whose run was stopped or failed: it continues where it stopped, with everything it had already done.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Sub-agent session ID (e.g. 'subagent/researcher-a7b3')" },
        message: { type: "string", description: "Message to send. Omit it to resume the sub-agent where its last run stopped." },
        attachments: {
          type: "array",
          description: "Optional files to include",
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              type: { type: "string", enum: ["image", "video", "audio", "file"] },
            },
            required: ["path", "type"],
          },
        },
      },
      required: ["id"],
    },
    async execute(args): Promise<ToolResult> {
      try {
        const id = str(args, "id");
        // Absent or blank: resume. A model that wants to resume sometimes sends an empty string.
        const raw = typeof args["message"] === "string" ? args["message"] : "";
        const message = raw.trim() === "" ? undefined : raw;
        const attachments = (args["attachments"] as Array<{ path: string; type: string }> | undefined)?.map((a) => ({ path: a.path, type: a.type as Attachment["type"] }));
        const parentMessage = args["__message"] as UnifiedMessage | undefined;
        if (!parentMessage) {
          return { success: false, output: "", error: "Missing parent message context" };
        }
        const signal = args["__signal"] as AbortSignal | undefined;
        const callerSessionId = typeof args["__sessionId"] === "string" ? args["__sessionId"] : "";
        // Carried for the same reason as in `spawn`: it is what ties the sub-agent's lifecycle to
        // the card this tool call painted, live and in replayed history.
        const toolCallId = typeof args["__toolCallId"] === "string" ? args["__toolCallId"] : undefined;
        const result = await runner.send(id, message, attachments, parentMessage, registry, callerSessionId, signal, undefined, toolCallId, streamProvider);
        return { success: !result.startsWith("Error:"), output: result, error: result.startsWith("Error:") ? result : undefined };
      } catch (e) {
        // A real Stop of the caller ends the caller's run. Anything else is this call's own
        // failure, and a child stopped on its own has to say so instead of implicating the caller
        // (2026-09-21: one sub-agent of three dying read as the whole run being stopped). docs/stop.md
        rethrowIfAborted(e, args["__signal"] as AbortSignal | undefined);
        if (isAbort(e)) {
          return {
            success: false,
            output: "",
            error: `The sub-agent's run was stopped before it answered.${resumeHint(str(args, "id") ? (str(args, "id").startsWith("subagent/") ? str(args, "id") : `subagent/${str(args, "id")}`) : undefined)}`,
          };
        }
        return { success: false, output: "", error: String(e) };
      }
    },
  };
}
