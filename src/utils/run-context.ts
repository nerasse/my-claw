/**
 * A correlation id for everything one inbound message triggers: routing, the agent loop, the
 * LLM calls, the tools, the sub-agents. The logger stamps it on every line, so a user can
 * quote one short id and the whole run can be pulled out of the files.
 *
 * It rides in an AsyncLocalStorage rather than a parameter: the alternative is threading an id
 * through every function of 48 modules, which nobody would keep up to date.
 */

import { AsyncLocalStorage } from "node:async_hooks";

export interface RunContext {
  /** Short on purpose: it is meant to be read off a phone screen and typed back. */
  runId: string;
  platform?: string;
  sessionId?: string;
}

const storage = new AsyncLocalStorage<RunContext>();

export function newRunId(): string {
  return Math.random().toString(16).slice(2, 10).padEnd(8, "0");
}

export function withRunContext<T>(init: Omit<RunContext, "runId"> & { runId?: string }, fn: () => Promise<T>): Promise<T> {
  return storage.run({ ...init, runId: init.runId ?? newRunId() }, fn);
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
