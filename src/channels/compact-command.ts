/**
 * `/compact`, shared by every channel. The local summarizer rewrites the history a run
 * resumes, so the session is held for the whole operation instead of being merely checked
 * once: without the hold, a message arriving a second later opens a run on the pre-compaction
 * transcript and the compaction is silently wasted.
 */

import type { CompactOutcome } from "../agent/backend.ts";
import { isAbort } from "../core/aborted.ts";
import type { MyClawConfig } from "../core/config.ts";
import { runRegistry } from "../core/run-registry.ts";
import { hooks } from "../hooks/index.ts";
import { compactSessionForCommand } from "../sessions/compaction.ts";
import { cancelSpeculation } from "../sessions/compaction-speculative.ts";
import type { SessionData } from "../sessions/store.ts";

export interface CompactCommandParams {
  config: MyClawConfig;
  session: SessionData;
  /** The `/compact <instructions>` argument: extra guidance for the local summarizer. */
 instructions?: string;
  /** Writes the session back: the summarizer mutates it. */
  persist: () => Promise<void>;
  /** The app thread this came from, carried through to the completion notification. */
  threadId?: string;
}

export async function handleCompactCommand(p: CompactCommandParams): Promise<CompactOutcome> {
  const held = runRegistry.beginCompaction(p.session.id);
  if (!held) {
    return {
      text: runRegistry.isCompacting(p.session.id)
        ? "A compaction is already running on this session."
        : "A run is active on this session — try again once it finishes (or /stop first).",
      ok: false,
    };
  }
  // A compaction runs for one to two minutes with nothing on the wire until it ends: whoever
  // asked for it has usually left the screen by then, so its end is announced (docs/notifications.md).
  const startedAt = Date.now();
  const finished = (outcome: CompactOutcome): CompactOutcome => {
    hooks.emit("session:compact:finished", {
      sessionId: p.session.id,
      ...(p.threadId ? { threadId: p.threadId } : {}),
      engine: "local",
      durationMs: Date.now() - startedAt,
      ok: outcome.ok === true,
      text: outcome.text,
    });
    return outcome;
  };
  // A manual pass supersedes the background one: the owner asked for this summary, possibly with
  // instructions the armed one was never given, and committing both would move the floor twice.
  cancelSpeculation(p.session.id);
  try {
    // The hold's signal is the one `/stop` and the app's Stop button abort (`runRegistry.stop`):
    // handed to the summarizer, a stop reaches a compaction that has one to two minutes to run.
    const result = await compactSessionForCommand(p.config, p.session, p.instructions, held.signal);
    if (!result.ok) return finished({ text: result.reason ?? "Compaction failed.", ok: false });
    await p.persist();
    // Emitted after the session is written, so a window that reloads on the very next tick finds
    // the boundary in the history it asks for rather than only in this frame. An automatic pass
    // announces itself the same way, from the agent: one boundary, one shape, both origins.
    if (result.boundary && result.summary) {
      hooks.emit("session:compact:boundary", {
        sessionId: p.session.id,
        entryId: result.boundary.entryId,
        summary: result.summary,
        count: result.boundary.count,
      });
    }
    return finished({
      text: `Context compacted: ${result.beforeCount} → ${result.afterCount} messages.`,
      ok: true,
      ...(result.summary ? { summary: result.summary } : {}),
    });
  } catch (err) {
    // The owner stopped it: an answer, not a failure to report as one.
    if (isAbort(err, held.signal)) return finished({ text: "Compaction stopped.", ok: false });
    finished({ text: err instanceof Error ? err.message : String(err), ok: false });
    throw err;
  } finally {
    held.release();
  }
}
