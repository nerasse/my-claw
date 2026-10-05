/**
 * Test helper for tests that use the bridge with the session log.
 *
 * Sets up a shared log handle so the test can inspect what the bridge wrote without
 * racing against the async disk writes.
 */
import { mkdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { sessionDir, openSessionLog, type SessionLog, type Provisioned, type Entry, type UserEntry, type PhaseEntry, type ToolEntry, type CompactionEntry, type CommandEntry, type FailureEntry } from "../../src/sessions/log.ts";
import { setSessionLogResolver, resetSessionLogResolver } from "../../src/sessions/log-access.ts";
import { type LegacySessionData, type SessionMessage, type SessionCommandEntry, type SessionFailureEntry } from "../../src/sessions/store.ts";
import { metaOf, writeMeta } from "../../src/sessions/meta.ts";
import { MY_CLAW_DIR } from "../../src/core/config.ts";
import { writeJsonFileAtomically } from "../../src/utils/atomic-write.ts";
import { join } from "node:path";
import { splitAttachmentBlock, stripLocationBlock } from "../../src/agent/preprocess.ts";
import type { ChatLocation } from "../../src/channels/types.ts";
import type { SessionAttachment } from "../../src/sessions/store.ts";

export interface SessionLogSetup {
  log: SessionLog;
  cleanup: () => void;
}

const activeSetups = new Map<string, SessionLog>();
/**
 * The last log opened for each id, kept past its cleanup: a test's `afterEach` cleanup runs
 * before the next test's setup, so `activeSetups` no longer holds the log whose appends are
 * still in flight by then.
 */
const lastLogs = new Map<string, SessionLog>();

/**
 * Parses old-style message content to extract structured metadata.
 * Mimics what preprocess.ts does for live messages.
 */
function parseUserContent(content: string): {
  text: string;
  attachments?: SessionAttachment[];
  location?: ChatLocation;
  transcripts?: Record<string, string>;
} {
  let text = content;
  const attachments: SessionAttachment[] = [];
  let location: ChatLocation | undefined;
  const transcripts: Record<string, string> = {};

  // Extract [Attachments] block
  const { text: withoutAttach, attachments: parsedAttach } = splitAttachmentBlock(text);
  text = withoutAttach;

  // Convert block entries to structured attachments
  // SessionAttachment only supports type: "image" with path required,
  // so we convert the parsed entries
  for (const entry of parsedAttach) {
    const [mimeType] = entry.details;
    // SessionAttachment is restrictive: { type: "image"; path: string; mimeType?: string }
    // For testing purposes, we store the path and mimeType
    const att: SessionAttachment = {
      type: "image",  // SessionAttachment only allows "image"
      path: entry.source,
      ...(mimeType ? { mimeType } : {}),
    };
    attachments.push(att);
  }

  // Extract [Audio]: "..." transcripts
  // SessionAttachment only supports type: "image", so we can't properly associate
  // transcripts with audio attachments. For now, store them by index.
  const audioPattern = /\[Audio(?:\s+\d+)?\]:\s*"([^"]*)"/g;
  let audioMatch: RegExpExecArray | null;
  let audioIndex = 0;
  while ((audioMatch = audioPattern.exec(content)) !== null) {
    // Use attachment path as key if available
    if (audioIndex < attachments.length && attachments[audioIndex]!.path) {
      transcripts[attachments[audioIndex]!.path] = audioMatch[1]!;
    }
    audioIndex++;
  }
  // Remove [Audio] lines from text
  text = text.replace(/\[Audio(?:\s+\d+)?\]:\s*"[^"]*"\n*/g, "").trim();

  // Strip [Shared location] block
  text = stripLocationBlock(text);

  return {
    text,
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(location ? { location } : {}),
    ...(Object.keys(transcripts).length > 0 ? { transcripts } : {}),
  };
}

/**
 * Opens a session log and configures the resolver to return it.
 * Call cleanup() in afterEach to reset.
 */
export async function setupSessionLog(sessionId: string): Promise<SessionLogSetup> {
  // A setup for the same id may still have appends in flight: an append is fire-and-forget, and
  // the rm below takes the file out from under it. Left alone, those bytes land in the file this
  // setup is about to create and the new log opens with a turn from the old one inside it.
  await lastLogs.get(sessionId)?.flush();
  await rm(sessionDir(sessionId), { recursive: true, force: true });
  await mkdir(sessionDir(sessionId), { recursive: true });
  const log = await openSessionLog(sessionId);
  activeSetups.set(sessionId, log);
  lastLogs.set(sessionId, log);

  setSessionLogResolver(async (id) => {
    const cached = activeSetups.get(id);
    if (cached) return cached;
    return openSessionLog(id);
  });

  return {
    log,
    cleanup: () => {
      activeSetups.delete(sessionId);
      if (activeSetups.size === 0) {
        resetSessionLogResolver();
      }
    },
  };
}

/**
 * Converts old-style session messages to log entries and appends them.
 * Use this to migrate tests that used saveSession with messages.
 *
 * The conversion maps:
 * - user message -> UserEntry
 * - assistant message (text only) -> PhaseEntry
 * - assistant message (with toolCalls) -> PhaseEntry for text + ToolEntry per tool call
 * - tool message -> merged into the ToolEntry of the owning call
 * - user message with summaryOf -> CompactionEntry
 *
 * Commands and failures are handled by `appendCommands` and `appendFailures`.
 */
export function appendMessages(
  log: SessionLog,
  messages: SessionMessage[],
  commands?: SessionCommandEntry[],
  failures?: SessionFailureEntry[],
): void {
  // Build a map of tool outputs by toolCallId
  const toolOutputs = new Map<string, { content: string; timestamp: string }>();
  for (const msg of messages) {
    if (msg.role === "tool") {
      toolOutputs.set(msg.toolCallId, { content: msg.content, timestamp: msg.timestamp });
    }
  }

  // Track tool calls that need results
  const pendingTools = new Map<string, { name: string; args: Record<string, unknown>; runId: string; durationMs?: number; spawn?: SessionMessage extends { role: "assistant" } ? SessionMessage["toolCalls"] extends Array<infer T> ? T extends { spawn?: infer S } ? S : never : never : never }>();

  let runId = randomUUID();

  for (const msg of messages) {
    if (msg.role === "tool") continue; // handled via toolOutputs map

    if (msg.role === "user") {
      // Check for compaction summary
      if (msg.summaryOf !== undefined && msg.summaryOf > 0) {
        // This is a compaction boundary
        const summaryMatch = /\[Prior context summarized\]\n([\s\S]*?)\n\n\[End of summary/.exec(msg.content);
        const summary = summaryMatch?.[1] ?? msg.content;
        // Find the first kept entry id - it's the next entry after this one
        // For now, use the current leaf since we'll set it correctly after
        const firstKeptId = log.leaf() ?? "unknown";
        log.append<CompactionEntry>({
          type: "compaction",
          prompt: true,
          summary,
          firstKeptEntryId: firstKeptId,
          tokensBefore: 0,
          count: msg.summaryOf,
        });
      } else {
        // Parse the content to extract structured metadata
        const parsed = parseUserContent(msg.content);
        log.append<UserEntry>({
          type: "user",
          prompt: true,
          text: parsed.text,
          // Use structured data from message if available, else parsed from content
          ...(msg.attachments?.length ? { attachments: msg.attachments } : parsed.attachments?.length ? { attachments: parsed.attachments } : {}),
          ...(msg.location ? { location: msg.location } : parsed.location ? { location: parsed.location } : {}),
          ...(parsed.transcripts && Object.keys(parsed.transcripts).length > 0 ? { transcripts: parsed.transcripts } : {}),
        });
      }
      runId = randomUUID(); // New run for each user turn
    } else if (msg.role === "assistant") {
      // If there are tool calls, we'll handle them specially
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        // Always append a phase for the assistant turn (even if empty): the projection
        // gathers tools by walking from the phase entry, so orphan tools are lost.
        log.append<PhaseEntry>({
          type: "phase",
          prompt: true,
          text: msg.content,
          runId,
          ...(msg.reasoning ? { reasoning: msg.reasoning } : {}),
          ...(msg.reasoningTokens !== undefined ? { reasoningTokens: msg.reasoningTokens } : {}),
        });
        // Append each tool call
        for (const call of msg.toolCalls) {
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(call.arguments);
          } catch {
            args = { raw: call.arguments };
          }
          const output = toolOutputs.get(call.id);
          log.append<ToolEntry>({
            type: "tool",
            prompt: true,
            callId: call.id,
            name: call.name.replace(/^mcp__myclaw__/, ""), // strip wrapper prefix
            args,
            output: output?.content ?? "",
            truncated: false,
            ok: true,
            runId,
            ...(call.durationMs !== undefined ? { durationMs: call.durationMs } : {}),
            ...(call.spawn ? { spawn: call.spawn } : {}),
          });
        }
      } else if (msg.segments && msg.segments.length > 0) {
        // Multiple phases (thinking then responding multiple times)
        for (const seg of msg.segments) {
          log.append<PhaseEntry>({
            type: "phase",
            prompt: true,
            text: seg.content ?? "",
            runId,
            ...(seg.reasoning ? { reasoning: seg.reasoning } : {}),
          });
        }
      } else {
        // Plain text response
        log.append<PhaseEntry>({
          type: "phase",
          prompt: true,
          text: msg.content,
          runId,
          ...(msg.reasoning ? { reasoning: msg.reasoning } : {}),
          ...(msg.reasoningTokens !== undefined ? { reasoningTokens: msg.reasoningTokens } : {}),
        });
      }
    }
  }

  // Append commands
  if (commands) {
    for (const cmd of commands) {
      log.append<CommandEntry>({
        type: "command",
        prompt: false,
        input: cmd.input,
        output: cmd.output,
        ...(cmd.details ? { details: cmd.details } : {}),
      });
    }
  }

  // Append failures
  if (failures) {
    for (const fail of failures) {
      log.append<FailureEntry>({
        type: "failure",
        prompt: false,
        error: fail.error,
      });
    }
  }
}

/**
 * Writes the flat `<id>.json` a pre-switch install had. Production no longer writes this shape --
 * the migration is the only thing that reads it -- so the writer lives here, with the tests that
 * need a legacy file on disk.
 */
export async function writeLegacySessionFile(sessionId: string, data: LegacySessionData): Promise<void> {
  const safe = sessionId.replace(/\.\./g, "_").replace(/\0/g, "");
  await writeJsonFileAtomically(join(MY_CLAW_DIR, "sessions", `${safe}.json`), data, true);
}

/**
 * Creates a session the way the storage expects it: settings in the directory, turns in the log.
 *
 * Takes the legacy shape because that is how the fixtures are written -- a list of messages is a
 * readable way to describe a conversation -- and converts it, exactly as the migration does.
 */
export async function saveSessionWithLog(sessionId: string, data: LegacySessionData): Promise<SessionLogSetup> {
  const { log, cleanup } = await setupSessionLog(sessionId);
  appendMessages(log, data.messages, data.commands, data.failures);
  await writeMeta(sessionId, metaOf(data, log.leaf()));
  return { log, cleanup };
}
