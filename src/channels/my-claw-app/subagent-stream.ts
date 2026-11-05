import type { UnifiedMessage } from "../types.ts";
import type { SubAgentStream } from "../../subagents/runner.ts";
import type { MyClawAppStreamer } from "./stream.ts";

/**
 * How a sub-agent's run reports itself to the app: the stream the runner hands its bridge, built
 * over the streamer its thread owns.
 *
 * One door, because the app is the only surface a sub-agent's work shows on, and because what it
 * forwards is a contract rather than a detail: the prose, the tool cards, the thinking, and the
 * turn switch a steering message rides. The thinking was the one field nobody filled -- the type
 * carried it since the app first drove a sub-agent, so a window watching one saw its prose and
 * never a word of what it thought, while its log held every summary (2026-09-30).
 *
 * Read from the maps on every call, never captured: a steered child swaps its streamer mid-run,
 * and a captured one would keep painting into the sealed bubble.
 */
export function subAgentStreamFor(
  streamers: Map<string, MyClawAppStreamer>,
  renew: Map<string, (injected: UnifiedMessage) => MyClawAppStreamer>,
  subagentId: string,
  onInjected: (injected: UnifiedMessage) => void,
): SubAgentStream | undefined {
  if (!streamers.has(subagentId)) return undefined;
  const streamer = (): MyClawAppStreamer | undefined => streamers.get(subagentId);
  return {
    onToken: async (token) => { await streamer()?.push(token); },
    onToolUse: async (tools, verbose) => { await streamer()?.appendToolUse(tools, verbose); },
    onToolStart: async (call) => { await streamer()?.appendToolStart([call]); },
    reasoning: {
      onText: async (delta) => { await streamer()?.pushReasoning(delta); },
      onCount: async (count) => { await streamer()?.pushReasoningCount(count); },
      onCallStart: async () => { await streamer()?.beginWait(); },
      onFirstOutput: async (ms) => { await streamer()?.pushWait(ms); },
      onRestart: async () => { await streamer()?.restart(); },
    },
    // A sub-agent driven by the model gets the same turn-switch contract as one driven from the
    // app: the bubble in flight is sealed and the answer to the steering message opens a fresh
    // one. Without it the reply melted into the previous bubble and `message:injected` was never
    // emitted, so the owner's message stayed marked "queued for the next turn" for good.
    onTurnSwitch: async (injected) => {
      await streamer()?.finish();
      const next = renew.get(subagentId);
      if (next) streamers.set(subagentId, next(injected));
      else streamers.delete(subagentId);
      onInjected(injected);
    },
  };
}
