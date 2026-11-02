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
import { compactSession } from "../sessions/compaction.ts";
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
  /**
   * Arms the conversation's quota wait for the compaction that just died on a spent plan.
   *
   * Injected by the channel that owns the tick, because the decision ("is this a wall, and when
   * does it reopen") lives there and must not have a second answer here. Resolves to what to tell
   * the owner when a wait was armed, `undefined` when this failure earns none -- the command then
   * reports the failure as before.
   */
  queueQuotaRetry?: (cause: unknown) => Promise<string | undefined>;
}

export async function handleCompactCommand(p: CompactCommandParams): Promise<CompactOutcome> {
  // A `/compact` typed during a run waits for that whole run to end, and its marker is up from
  // here: a message sent after it queues behind the compaction instead of being folded into the
  // run that is ending (docs/compaction.md).
  const held = await runRegistry.beginQueuedCompaction(p.session.id);
  if (!held) {
    return {
      text: "A compaction is already queued or running on this session.",
      ok: false,
    };
  }
  // `/stop` reached it while it waited: an answer, not a compaction that never started.
  if (held.signal.aborted) {
    held.release();
    return { text: "Compaction stopped.", ok: false };
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
    const result = await compactSession(p.config, p.session, p.instructions, held.signal);
    if (!result.ok) {
      // A wall the conversation asked to wait out: the compaction queues itself and the quota tick
      // fires it, exactly as a failed run is resumed -- docs/quota-retry.md.
      if (result.retryableQuota && p.queueQuotaRetry) {
        const armed = await p.queueQuotaRetry(result.cause).catch(() => undefined);
        if (armed) return finished({ text: armed, ok: false });
      }
      return finished({ text: result.reason ?? "Compaction failed.", ok: false });
    }
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
        ...(result.archive ? { archive: result.archive } : {}),
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
