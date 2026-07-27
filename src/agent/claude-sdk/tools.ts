import { tool as sdkTool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { Tool } from "../../tools/types.ts";
import { READ_ONLY_TOOLS } from "../../tools/registry.ts";
import type { UnifiedMessage, Attachment } from "../../channels/types.ts";
import type { SessionData } from "../../sessions/store.ts";
import { jsonSchemaToZodShape } from "./schema.ts";
import type { NestedAgentsCollector } from "../prompt/nested-agents.ts";
import { hooks } from "../../hooks/index.ts";
import { AbortedError, isAbort } from "../../core/aborted.ts";
import { log } from "../../utils/logger.ts";
import { errorLogData } from "../../utils/errors.ts";

export const MCP_SERVER_NAME = "myclaw";

// Mirrors the home loop's tool-result hygiene (bridge.ts): the model must never see an
// empty result, and no single output may poison the whole context.
const EMPTY_TOOL_OUTPUT = "[tool returned an empty response]";
const MAX_TOOL_OUTPUT_CHARS = 60_000;

function capToolOutput(content: string): string {
  if (content.length <= MAX_TOOL_OUTPUT_CHARS) return content;
  return `${content.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n\n[... truncated: ${content.length} chars total, ${MAX_TOOL_OUTPUT_CHARS} kept ...]`;
}

export interface SdkRunContext {
  message: UnifiedMessage;
  session: SessionData;
  depth: number;
  signal?: AbortSignal;
  workspaceDir?: string;
  addAttachment: (att: Attachment) => void;
  // Run-local, like the home loop: dedup and byte budget reset every run, so an edited
  // nested AGENTS.md is re-read from disk on the next message.
  nestedAgents?: NestedAgentsCollector;
  // Fired after each tool completes so the backend can stream tool-status to the channel.
  onToolDone?: (info: { name: string; arguments: Record<string, unknown>; durationMs: number }) => Promise<void>;
}

interface WrappedResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

async function runTool(t: Tool, args: Record<string, unknown>, ctx: SdkRunContext): Promise<WrappedResult> {
  if (ctx.signal?.aborted) throw new AbortedError();

  const toolGate = await hooks.check("gate:tool:before", {
    toolName: t.name,
    args,
    sessionId: ctx.session.id,
  });
  if (!toolGate.allowed) {
    return { content: [{ type: "text", text: `Error: tool blocked by gate: ${toolGate.reason ?? "no reason"}` }], isError: true };
  }

  const startedAt = Date.now();
  hooks.emit("tool:execute:start", {
    toolName: t.name,
    toolCallId: `sdk-${startedAt}`,
    sessionId: ctx.session.id,
    iteration: 0,
    args,
  });

  let content: string;
  let success: boolean;
  try {
    const result = await t.execute({
      ...args,
      __depth: ctx.depth,
      __message: ctx.message,
      __workspaceDir: ctx.workspaceDir,
      __signal: ctx.signal,
    });
    if (ctx.signal?.aborted) throw new AbortedError();
    for (const att of result.attachments ?? []) ctx.addAttachment(att);
    if (result.success) {
      success = true;
      content = capToolOutput(result.output.trim().length > 0 ? result.output : EMPTY_TOOL_OUTPUT);
    } else {
      success = false;
      const detail = (result.error ?? result.output).trim();
      content = capToolOutput(`Error: ${detail.length > 0 ? detail : "tool failed with no message"}`);
    }
  } catch (err) {
    if (isAbort(err, ctx.signal)) throw err;
    void log("error", "tool execution failed", { tool: t.name, error: errorLogData(err) });
    success = false;
    content = `Error: ${String(err)}`;
  }

  const durationMs = Date.now() - startedAt;
  content = (await hooks.transform("transform:tool:result", {
    toolName: t.name,
    result: content,
    sessionId: ctx.session.id,
    toolCallId: `sdk-${startedAt}`,
  })).result;

  if (ctx.nestedAgents) {
    content += ctx.nestedAgents.collect(t.name, args);
  }

  hooks.emit(success ? "tool:execute:end" : "tool:execute:error", success
    ? { toolName: t.name, toolCallId: `sdk-${startedAt}`, sessionId: ctx.session.id, success: true, outputChars: content.length, durationMs }
    : { toolName: t.name, toolCallId: `sdk-${startedAt}`, sessionId: ctx.session.id, error: new Error(content), durationMs });

  if (ctx.onToolDone) await ctx.onToolDone({ name: t.name, arguments: args, durationMs });

  return { content: [{ type: "text", text: content }], isError: success ? undefined : true };
}

/**
 * Build the in-process MCP server for one run. Rebuilt per run on purpose: the SDK tool
 * handler has no side channel, so the run context (message, signal, workspace, depth,
 * attachments) travels through these closures. Cheap: plain in-process object.
 */
export function createToolServerForRun(tools: Tool[], ctx: SdkRunContext): ReturnType<typeof createSdkMcpServer> {
  const sdkTools = tools.map((t) =>
    sdkTool(
      t.name,
      t.description,
      jsonSchemaToZodShape(t.parameters),
      async (args: Record<string, unknown>) => runTool(t, args, ctx),
      {
        // Preload every tool: 22 tools fit comfortably; ToolSearch discovery would add a
        // round trip before the first call (observed in the phase 0 spike).
        alwaysLoad: true,
        annotations: READ_ONLY_TOOLS.includes(t.name) ? { readOnlyHint: true } : undefined,
      },
    ),
  );
  return createSdkMcpServer({ name: MCP_SERVER_NAME, version: "1.0.0", tools: sdkTools });
}
