import { type Tool, type ToolResult, str, strOpt } from "./types.ts";
import { resumeHint, SubAgentRunner, type SubAgentStream, type SubAgentExecution } from "../subagents/runner.ts";
import { SubAgentRegistry } from "../subagents/registry.ts";
import { blockedReportOf, describeBlocked, handoffCallsIn } from "../subagents/blocked.ts";
import { classifyProviderFailure } from "../llm/outage.ts";
import { judgePins, refuseUnknownModel } from "./model-choice.ts";
import type { UnifiedMessage, Attachment } from "../channels/types.ts";
import { isAbort, rethrowIfAborted } from "../core/aborted.ts";

/**
 * The execution settings a `send` may carry: the same model/effort/ceiling a `spawn` takes, plus
 * the fallback policy. `model` is judged against the same list both other doors use, so an id that
 * only looks right cannot reach a run.
 *
 * Absent settings are absent, not cleared: a caller that names nothing leaves the agent exactly as
 * it was, which is what every existing `send` call relies on.
 */
function executionOf(args: Record<string, unknown>, modelIds: () => string[]): { ok: true; execution?: SubAgentExecution } | { ok: false; error: string } {
  const model = strOpt(args, "model");
  if (model) {
    const refused = refuseUnknownModel(model, modelIds());
    if (refused) return { ok: false, error: refused };
  }
  const asked = judgePins(args);
  if (!asked.ok) return { ok: false, error: asked.error };
  const fallback = strOpt(args, "fallback");
  if (fallback !== undefined && fallback !== "" && fallback !== "forbid" && fallback !== "inherit") {
    return { ok: false, error: `Unknown fallback "${fallback}". Use "forbid" to refuse any model but the named one, or omit it to inherit the configured chain.` };
  }
  const scope = strOpt(args, "scope");
  if (scope !== undefined && scope !== "" && scope !== "run" && scope !== "session") {
    return { ok: false, error: `Unknown scope "${scope}". Use "run" for this call alone, or "session" to keep the settings.` };
  }
  const changes = model !== undefined || asked.pins.effort !== undefined || asked.pins.contextCap !== undefined || fallback === "forbid";
  if (!changes) return { ok: true };
  return {
    ok: true,
    execution: {
      ...(model ? { model } : {}),
      ...(asked.pins.effort ? { effort: asked.pins.effort } : {}),
      ...(asked.pins.contextCap !== undefined ? { contextCap: asked.pins.contextCap } : {}),
      ...(fallback === "forbid" ? { fallback: "forbid" } : {}),
      // Run-scoped unless stated: changing an agent's standing model as a side effect of resuming
      // it is a choice the caller makes on purpose, not one it walks into.
      scope: scope === "session" ? "session" : "run",
    },
  };
}

export function createSendTool(
  runner: SubAgentRunner,
  registry: SubAgentRegistry,
  streamProvider?: (subagentId: string) => SubAgentStream | undefined,
  listModelIds?: () => string[],
): Tool {
  return {
    name: "send",
    description: "Send a message to an existing sub-agent. The sub-agent loads its full session history, processes the message, and saves the updated session. Blocks if the sub-agent is already running. Leave the message out to resume a sub-agent whose run was stopped or failed: it continues where it stopped, with everything it had already done. model/effort/contextCap/fallback change how it runs as part of the same call; scope='run' (default) applies them to this call alone.",
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
        model: {
          type: "string",
          description: "Optional: run this call on another model (a tag such as tag:Smart, or a whole provider/model id). Omit to keep the agent's own.",
        },
        effort: {
          type: "string",
          description: "Optional reasoning effort for this call: low, medium, high, xhigh, max, ultra. Omit to keep the agent's own.",
        },
        contextCap: {
          type: "number",
          description: "Optional ceiling on the context window this call may use, in tokens. Omit to keep the agent's own.",
        },
        fallback: {
          type: "string",
          enum: ["forbid", "inherit"],
          description: "'forbid' = if this model's provider fails, stop and report instead of answering on another model. Omit to inherit the configured chain.",
        },
        scope: {
          type: "string",
          enum: ["run", "session"],
          description: "How long model/effort/contextCap/fallback last: 'run' (default) for this call only, 'session' to keep them for the agent's later runs.",
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
        const asked = executionOf(args, listModelIds ?? (() => []));
        if (!asked.ok) return { success: false, output: "", error: asked.error };
        const signal = args["__signal"] as AbortSignal | undefined;
        const callerSessionId = typeof args["__sessionId"] === "string" ? args["__sessionId"] : "";
        // Carried for the same reason as in `spawn`: it is what ties the sub-agent's lifecycle to
        // the card this tool call painted, live and in replayed history.
        const toolCallId = typeof args["__toolCallId"] === "string" ? args["__toolCallId"] : undefined;
        const result = await runner.send(id, message, attachments, parentMessage, registry, callerSessionId, signal, undefined, toolCallId, streamProvider, asked.execution);
        return { success: !result.startsWith("Error:"), output: result, error: result.startsWith("Error:") ? result : undefined };
      } catch (e) {
        // A real Stop of the caller ends the caller's run. Anything else is this call's own
        // failure, and a child stopped on its own has to say so instead of implicating the caller
        // (2026-09-21: one sub-agent of three dying read as the whole run being stopped). docs/stop.md
        rethrowIfAborted(e, args["__signal"] as AbortSignal | undefined);
        const requested = str(args, "id");
        const canonical = requested ? (requested.startsWith("subagent/") ? requested : `subagent/${requested}`) : "";
        if (isAbort(e)) {
          return {
            success: false,
            output: "",
            error: `The sub-agent's run was stopped before it answered.${resumeHint(canonical || undefined)}`,
          };
        }
        // A provider failure is the one case a parent can act on, so it gets the structured shape
        // instead of prose: what class of failure, whether tools already ran, when the provider said
        // its limit reopens, and what the kept history still allows.
        if (canonical && classifyProviderFailure(e)) {
          const calls = await handoffCallsIn(canonical);
          const report = blockedReportOf({ agentId: canonical, err: e, toolsRan: calls.length > 0, calls });
          const text = describeBlocked(report, String(e));
          return { success: false, output: text, error: text };
        }
        return { success: false, output: "", error: `The sub-agent failed: ${String(e)}.${resumeHint(canonical || undefined)}` };
      }
    },
  };
}


