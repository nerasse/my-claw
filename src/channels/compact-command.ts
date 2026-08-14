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
}

export async function handleCompactCommand(p: CompactCommandParams): Promise<CompactOutcome> {
  const held = runRegistry.beginCompaction(p.session.id);
  if (!held) {
    return {
      text: runRegistry.isCompacting(p.session.id)
        ? "A compaction is already running on this session."
        : "A run is active on this session — try again once it finishes (or /stop first).",
    };
  }
  try {
    if (isSdkBackedModel(p.config.llm, p.session.modelOverride) && p.sdkCompact) {
      const outcome = await p.sdkCompact(p.session, held.signal);
      await p.persist();
      return outcome;
    }
    const result = await compactSession(p.config, p.session, p.instructions);
    if (!result.ok) return { text: result.reason ?? "Compaction failed." };
    await p.persist();
    return {
      text: `Context compacted: ${result.beforeCount} → ${result.afterCount} messages.`,
      ...(result.summary ? { summary: result.summary } : {}),
    };
  } finally {
    held.release();
  }
}
