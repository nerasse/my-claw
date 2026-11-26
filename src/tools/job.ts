/**
 * The reader and the stop for a background job -- docs/jobs.md.
 *
 * A job's end is pushed into the conversation, so this tool is not how a model waits for one: it is
 * how it *collects* what a notice said, and how it stops work it no longer wants. The wording of
 * every answer says so, because a model that polls spends its turns proving nothing and turns a
 * background build back into the freeze this replaced.
 */

import type { Tool, ToolResult } from "./types.ts";
import { num, str, strOpt } from "./types.ts";
import { jobs, type JobRecord } from "../core/jobs.ts";
import { rethrowIfAborted } from "../core/aborted.ts";

const OFFSET_HINT = "Pass `offset` with the value this answer printed to read only what is new.";

function statusLine(record: JobRecord, now = Date.now()): string {
  const elapsed = Math.max(0, (record.endedAt ?? now) - record.startedAt);
  const span = elapsed < 60_000
    ? `${Math.round(elapsed / 1000)} s`
    : elapsed < 3_600_000
      ? `${Math.round(elapsed / 60_000)} min`
      : `${(elapsed / 3_600_000).toFixed(1)} h`;
  const exit = record.exitCode === undefined || record.exitCode === null ? "" : `, exit ${record.exitCode}`;
  const signal = record.signal ? `, ${record.signal}` : "";
  const note = record.note ? `, ${record.note}` : "";
  return `[job ${record.id} ${record.status}${exit}${signal}, ${span}${note}]`;
}

function listLine(record: JobRecord): string {
  const label = record.label.replace(/\s+/g, " ").trim().slice(0, 120);
  return `${statusLine(record)}\n  ${record.tool}: ${label}\n  output: ${record.outputPath}`;
}

export const jobTool: Tool = {
  name: "job",
  description:
    "Read or stop a background job. A command that outlived its call became one, and you are told " +
    "with a <job> message when it finishes: collect it with `output`, never by waiting on it. " +
    "`list` shows this conversation's jobs, `kill` stops one you no longer need.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["output", "list", "kill"], description: "What to do." },
      id: { type: "string", description: "The job id, as the launch or the notice printed it." },
      offset: {
        type: "number",
        description: "Where to start reading. Use the value the previous read printed to get only what is new.",
      },
      waitMs: {
        type: "number",
        description: "For `output`: wait this long for something new before answering (max 60000). Use it only when genuinely blocked.",
      },
      maxChars: { type: "number", description: "For `output`: how much to read at once (default 20000)." },
      includeSettled: { type: "boolean", description: "For `list`: include finished jobs (default true)." },
    },
    required: ["action"],
  },
  async execute(args): Promise<ToolResult> {
    const sessionId = strOpt(args, "__sessionId") ?? "";
    const signal = args["__signal"] as AbortSignal | undefined;
    rethrowIfAborted(undefined, signal);
    if (!sessionId) return { success: false, output: "", error: "no conversation owns this job." };
    const action = str(args, "action").trim();
    const id = str(args, "id").trim();

    if (action === "list") {
      const includeSettled = args["includeSettled"] !== false;
      const records = await jobs.list(sessionId, { includeSettled });
      if (records.length === 0) return { success: true, output: "(no background jobs)" };
      return { success: true, output: records.map(listLine).join("\n\n") };
    }

    if (action === "kill") {
      if (!id) return { success: false, output: "", error: "`id` is required for kill." };
      const record = await jobs.kill(sessionId, id);
      if (!record) return { success: false, output: "", error: `no job ${id} in this conversation.` };
      return {
        success: true,
        output: record.status === "running"
          ? `Cancellation requested for job ${record.id}; the notice will say how it ended.`
          : `${statusLine(record)}`,
      };
    }

    if (action !== "output") {
      return { success: false, output: "", error: "`action` must be one of output, list, kill." };
    }
    if (!id) return { success: false, output: "", error: "`id` is required for output." };
    const read = await jobs.output(sessionId, id, {
      offset: Math.max(0, num(args, "offset", 0)),
      maxChars: Math.max(1, num(args, "maxChars", 20_000)),
      waitMs: Math.max(0, num(args, "waitMs", 0)),
      ...(signal ? { signal } : {}),
    });
    if (!read) return { success: false, output: "", error: `no job ${id} in this conversation.` };
    const body = read.text.length > 0 ? read.text : "(no new output)";
    return {
      success: true,
      output: `${body}\n\n${statusLine(read.record)}\n[next offset: ${read.offset}] ${OFFSET_HINT}`,
    };
  },
};
