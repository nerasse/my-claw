import type { ReasoningSink } from "../../agent/backend.ts";
import type { MyClawAppStreamer } from "./stream.ts";

/**
 * What the app draws of a run's own thinking, read through the streamer that is open at the time.
 *
 * Read per call and never captured: a message folded into a run in flight swaps the streamer, and
 * the sink has to follow the bubble that is open now (`index.ts`, the `active` it replaces).
 *
 * One door for the three things the app shows of a model's inner life: its reasoning, a redacted
 * engine's count, and the wait before a call's first token. The wait went through a global hook
 * first, and a hook is heard by every listener on the session -- a folded message has one too, so
 * every call after it opened two bubbles (2026-10-01). Same contract as a sub-agent's stream
 * (`subagent-stream.ts`), which is what made this one worth a name.
 */
export function runReasoningSink(current: () => MyClawAppStreamer): ReasoningSink {
  return {
    onText: (delta) => current().pushReasoning(delta),
    onTokens: (tokens) => current().pushReasoningTokens(tokens),
    onCallStart: () => current().beginThinking(),
  };
}
