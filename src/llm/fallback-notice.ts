import type { UnifiedMessage } from "../channels/types.ts";
import { hooks } from "../hooks/index.ts";
import { log } from "../utils/logger.ts";
import { TtlSet } from "../utils/lru-map.ts";
import { describe, type RunModel } from "./run-model.ts";

/**
 * Runs already announced. Keyed by the message the run answers, so the several resolutions of one
 * run -- the dispatcher picking the engine, then the backend resolving for real, then a reroute --
 * speak once between them.
 *
 * A TTL rather than a plain Set: a long-lived process would otherwise hold every message id it
 * ever saw, and an id is never worth remembering past the run that carries it.
 */
const announced = new TtlSet<string>(60 * 60 * 1000, 5_000);

/**
 * Says once, in the chat, that a configured model could not run and what ran instead. Silent on
 * the happy path.
 *
 * The four facts are what makes it fixable without reading a log: the model, why, where it is
 * pinned, and what answered instead. A notice that only said "falling back" would send the owner
 * looking through three config sections.
 */
export function announceModelFallback(run: RunModel, message: UnifiedMessage, agent: string): void {
  const first = run.skipped[0];
  if (!first) return;
  const key = `${message.id}:${agent}`;
  if (announced.has(key)) return;
  announced.add(key);

  const reason = describe(first.availability);
  void log("warn", "configured model cannot run; fell back", {
    agent,
    model: first.model,
    origin: first.origin,
    reason,
    ran: run.model,
    sessionMessageId: message.id,
  });
  hooks.emit("model:fallback", {
    platform: message.platform,
    chatId: message.chatId,
    ...(message.threadId ? { threadId: message.threadId } : {}),
    agent,
    model: first.model,
    origin: first.origin,
    reason,
    ran: run.model,
  });
}

/**
 * The sentence the channels post. One wording, so the three of them cannot drift.
 *
 * Tagged `[fallback]` like the note a run leaves when it switches mid-flight: it is the same fact
 * -- the model that was asked for is not the one answering -- and the surface draws one kind for
 * it (`core/notice.ts`). Without the tag it read as a third, anonymous "Note".
 */
export function fallbackNoticeText(p: {
  model: string;
  reason: string;
  origin: string;
  ran: string;
}): string {
  return `[fallback] ${p.model} is not available (${p.reason}), it is pinned in ${p.origin}. This run used ${p.ran} instead.`;
}

/** Test seam: the set is module state shared by every test file. */
export function resetFallbackNotices(): void {
  announced.clear();
}
