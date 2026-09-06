/**
 * A correlation id for everything one inbound message triggers: routing, the agent loop, the
 * LLM calls, the tools, the sub-agents. The logger stamps it on every line, so a user can
 * quote one short id and the whole run can be pulled out of the files.
 *
 * It rides in an AsyncLocalStorage rather than a parameter: the alternative is threading an id
 * through every function of 48 modules, which nobody would keep up to date.
 */

import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The ids of the bubbles a channel has opened and not yet handed over, oldest first. Taking them
 * empties the sink: they are claimed once, by the phases that were streamed into them --
 * docs/bubble-identity.md.
 */
export interface BubbleSink {
  take(): string[];
}

export interface RunContext {
  /**
   * This run's id, short on purpose: it is meant to be read off a phone screen and typed back. A
   * sub-agent's run has its own (`withChildRunContext`), so two runs of one child inside one parent
   * run are two runs on the child's thread, on the wire and in its log.
   */
  runId: string;
  /**
   * The id of the inbound message everything here descends from; the same as `runId` on a root
   * run. The logger stamps it, so one quoted id still pulls the whole tree out of the files.
   */
  rootRunId: string;
  platform?: string;
  sessionId?: string;
  /**
   * Bubble ids per session. Keyed, because a sub-agent paints its own bubbles inside the parent's
   * run context: unkeyed, the child's ids would be claimed by the parent's phases.
   */
  bubbles?: Map<string, BubbleSink>;
}

const storage = new AsyncLocalStorage<RunContext>();

export function newRunId(): string {
  return Math.random().toString(16).slice(2, 10).padEnd(8, "0");
}

/**
 * Opens a run context, or reuses the one already open. Channels open it at ingress so the id
 * also covers what happens outside the router (building the streamer, flushing the final
 * bubble after the run returned); the router opens it for anything that reaches it directly,
 * like cron. Nesting would hand the same message two different ids.
 */
export function withRunContext<T>(init: Omit<RunContext, "runId" | "rootRunId"> & { runId?: string }, fn: () => Promise<T>): Promise<T> {
  const existing = storage.getStore();
  if (existing) return fn();
  const runId = init.runId ?? newRunId();
  return storage.run({ ...init, runId, rootRunId: runId }, fn);
}

/**
 * A run of its own inside the run in flight: what a sub-agent gets. Everything else is inherited,
 * the bubble sinks included (the same map, since the parent registers its child's sink before the
 * child reads it). Outside any run it opens a root, so a caller never has to know which it is in.
 */
export function withChildRunContext<T>(fn: () => Promise<T>): Promise<T> {
  const parent = storage.getStore();
  if (!parent) return withRunContext({}, fn);
  return storage.run({ ...parent, runId: newRunId() }, fn);
}

export function currentRun(): RunContext | undefined {
  return storage.getStore();
}

export function currentRunId(): string | undefined {
  return storage.getStore()?.runId;
}

/** The session is only known after the router resolves it, so it lands on the live context. */
export function setRunSession(sessionId: string): void {
  const ctx = storage.getStore();
  if (ctx) ctx.sessionId = sessionId;
}

/**
 * A channel announcing where it paints one session's answer. Called when the streamer is built,
 * which is inside the run context the channel opened at ingress.
 */
export function setRunBubbles(sessionId: string, sink: BubbleSink): void {
  const ctx = storage.getStore();
  if (!ctx) return;
  if (!ctx.bubbles) ctx.bubbles = new Map();
  ctx.bubbles.set(sessionId, sink);
}

/**
 * The ids of the bubbles opened for this session since the last call, oldest first. Empty when no
 * channel is painting this run (cron, a sub-agent nobody is watching), and the phases then keep
 * the ids the log mints for them.
 */
export function takeRunBubbles(sessionId: string): string[] {
  return storage.getStore()?.bubbles?.get(sessionId)?.take() ?? [];
}
