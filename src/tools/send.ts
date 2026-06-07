import { type Tool, type ToolResult, str } from "./types.ts";
import { SubAgentRunner } from "../subagents/runner.ts";
import { SubAgentRegistry } from "../subagents/registry.ts";
import type { UnifiedMessage, Attachment } from "../channels/types.ts";
import { rethrowIfAborted } from "../core/aborted.ts";

export function createSendTool(runner: SubAgentRunner, registry: SubAgentRegistry): Tool {
  return {
    name: "send",
    description: "Send a message to an existing persistent sub-agent. The sub-agent loads its full session history, processes the message, and saves the updated session. Blocks if the sub-agent is already running.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Sub-agent session ID (e.g. 'subagent/researcher-a7b3')" },
        message: { type: "string", description: "Message to send" },
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
      required: ["id", "message"],
    },
    async execute(args): Promise<ToolResult> {
      try {
        const id = str(args, "id");
        const message = str(args, "message");
        const attachments = (args["attachments"] as Array<{ path: string; type: string }> | undefined)?.map((a) => ({ path: a.path, type: a.type as Attachment["type"] }));
        const parentMessage = args["__message"] as UnifiedMessage | undefined;
        if (!parentMessage) {
          return { success: false, output: "", error: "Missing parent message context" };
        }
        const signal = args["__signal"] as AbortSignal | undefined;
        const result = await runner.send(id, message, attachments, parentMessage, registry, signal);
        return { success: !result.startsWith("Error:"), output: result, error: result.startsWith("Error:") ? result : undefined };
      } catch (e) {
        rethrowIfAborted(e, args["__signal"] as AbortSignal | undefined);
        return { success: false, output: "", error: String(e) };
      }
    },
  };
}
