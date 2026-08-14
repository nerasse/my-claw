/**
 * `/compact`, shared by every channel. Two engines answer it (docs/compaction.md): the SDK's own
 * compaction when the session's history lives in the SDK, the local summarizer otherwise. Both
 * rewrite the history a run resumes, so the session is held for the whole operation instead of
 * being merely checked once: without the hold, a message arriving a second later opens a run on
 * the pre-compaction transcript and the compaction is silently wasted.
 */

import type { CompactOutcome } from "../agent/backend.ts";
import type { MyClawConfig } from "../core/config.ts";
import { runRegistry } from "../core/run-registry.ts";
import { hooks } from "../hooks/index.ts";
import { isSdkBackedModel } from "../llm/resolver.ts";
import { compactSession } from "../sessions/compaction.ts";
import type { SessionData } from "../sessions/store.ts";

export interface CompactCommandParams {
  config: MyClawConfig;
  session: SessionData;
  /** The `/compact <instructions>` argument: extra guidance for the local summarizer. */
  instructions?: string;
  /** The SDK engine, when one is wired. Absent on a channel with no SDK backend. */
  sdkCompact?: (session: SessionData, stopSignal?: AbortSignal) => Promise<CompactOutcome>;
  /** Writes the session back: both engines mutate it. */
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
  const engine = isSdkBackedModel(p.config.llm, p.session.modelOverride) && p.sdkCompact ? "sdk" : "local";
  const finished = (outcome: CompactOutcome): CompactOutcome => {
    hooks.emit("session:compact:finished", {
      sessionId: p.session.id,
      ...(p.threadId ? { threadId: p.threadId } : {}),
      engine,
      durationMs: Date.now() - startedAt,
      ok: outcome.ok === true,
      text: outcome.text,
    });
    return outcome;
  };
  try {
    if (engine === "sdk" && p.sdkCompact) {
      const outcome = await p.sdkCompact(p.session, held.signal);
      await p.persist();
      return finished(outcome);
    }
    const result = await compactSession(p.config, p.session, p.instructions);
    if (!result.ok) return finished({ text: result.reason ?? "Compaction failed.", ok: false });
    await p.persist();
    return finished({
      text: `Context compacted: ${result.beforeCount} → ${result.afterCount} messages.`,
      ok: true,
      ...(result.summary ? { summary: result.summary } : {}),
    });
  } catch (err) {
    finished({ text: err instanceof Error ? err.message : String(err), ok: false });
    throw err;
  } finally {
    held.release();
  }
}
