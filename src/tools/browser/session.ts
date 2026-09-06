import { BrowserClient } from "../../browser/client.ts";
import type { MyClawConfig } from "../../core/config.ts";
import { type Tool, type ToolResult } from "../types.ts";
import { createBrowserPageState, type BrowserPageState } from "./state.ts";

export const DEFAULT_NOVNC_URL = "http://localhost:6080";
export const DEFAULT_SIDECAR_URL = "http://127.0.0.1:9223";

/**
 * The one browser, as the tools see it.
 *
 * There is a single Chromium behind the sidecar and every browser agent run drives it in turn
 * (`enqueueBrowserTask`), so the client and the page pointer are one shared pair rather than one
 * per run: the queue is what keeps two runs off each other's tab, and the pair is what lets a run
 * started by `send` (the owner continuing in the browser agent's own thread) find the browser
 * without a task handing it one. `cleanup()` closes the pages the run opened and forgets the page
 * pointer, so the next run starts on a fresh sidecar session.
 */
export class BrowserSession {
  readonly client: BrowserClient;
  readonly pageState: BrowserPageState = createBrowserPageState();

  constructor(private config: MyClawConfig) {
    this.client = new BrowserClient(this.sidecarUrl(), config.browser?.viewport, config.browser?.timeoutsMs);
  }

  sidecarUrl(): string {
    return this.config.browser?.sidecarUrl ?? DEFAULT_SIDECAR_URL;
  }

  /** Closes what the run opened and re-reads the config, so the next run starts clean on the sidecar the live config names. */
  async cleanup(): Promise<void> {
    this.pageState.currentPageId = null;
    await this.client.cleanup().catch(() => undefined);
    this.client.reconfigure(this.sidecarUrl(), this.config.browser?.viewport, this.config.browser?.timeoutsMs);
  }

  /**
   * The tabs already open in the shared browser, as a section of the task. The agent is told to
   * reuse them instead of opening duplicates; the list has to come from the run's start, not from
   * a tool the agent would have to think of calling first.
   */
  async describeOpenTabs(): Promise<string> {
    let tabs: Awaited<ReturnType<BrowserClient["listTabs"]>>;
    try {
      tabs = await this.client.listTabs();
    } catch {
      return "## Open browser tabs\n(could not read the current tabs)";
    }
    if (tabs.length === 0) {
      return "## Open browser tabs\nNone yet — the browser has no open tabs.";
    }
    const lines = tabs.map((t, i) => `[${i}] ${t.title ? `${t.title} — ` : ""}${t.url}`);
    return `## Open browser tabs\nThese are already open in the shared browser. Reuse a relevant one with browser_focus_tab; do not open duplicates or clobber unrelated tabs.\n${lines.join("\n")}`;
  }
}

// One Chromium: parallel browser runs used to fight over tabs, focus and refs and corrupt each
// other, so they are serialized here, whoever started them (a delegated task or a send).
let browserTaskQueue: Promise<unknown> = Promise.resolve();

export function enqueueBrowserTask<T>(run: () => Promise<T>): Promise<T> {
  const result = browserTaskQueue.then(run, run);
  browserTaskQueue = result.catch(() => undefined);
  return result;
}

/**
 * What a browser run wants its caller to know, beyond the text it answers with.
 *
 * The run is a real sub-agent now, so its result reaches `delegate_browser_task` as the text of
 * its last message. Two things do not fit in prose: whether a human must take over (the caller
 * routes that to the live browser), and whether the browser itself was down (a technical failure,
 * never a handoff). `browser_done` and the tools record them here, keyed by the run's session.
 */
export interface BrowserRunOutcome {
  summary?: string;
  needsHuman?: boolean;
  infraError?: string;
}

const outcomes = new Map<string, BrowserRunOutcome>();
/** A run the owner drives from the agent's own thread records an outcome nobody reads: the map stays bounded. */
const MAX_OUTCOMES = 50;

export function recordBrowserOutcome(sessionId: string, patch: BrowserRunOutcome): void {
  const merged = { ...outcomes.get(sessionId), ...patch };
  outcomes.delete(sessionId);
  outcomes.set(sessionId, merged);
  if (outcomes.size > MAX_OUTCOMES) {
    const oldest = outcomes.keys().next().value;
    if (oldest !== undefined) outcomes.delete(oldest);
  }
}

export function takeBrowserOutcome(sessionId: string): BrowserRunOutcome | undefined {
  const outcome = outcomes.get(sessionId);
  outcomes.delete(sessionId);
  return outcome;
}

/** Infrastructure failures: the browser sidecar or the shared Chromium behind it
 *  is unreachable. These are NOT human-solvable blockers — never route them to a
 *  noVNC handoff. Deliberately excludes generic page "timeout" (a slow site is
 *  a normal tool failure the agent can retry, not an infra outage). */
const INFRA_ERROR_SIGNATURES = [
  "econnrefused",
  "econnreset",
  "ehostunreach",
  "enetunreach",
  "sidecar unreachable",
  "connectovercdp",
  "websocket error",
  "browser has been closed",
  "target page, context or browser has been closed",
  "browser is closed",
  "connection closed",
];
// NB: a user-closed tab is handled at the sidecar (closed pages are pruned, so the next op returns
// "Unknown pageId" — a normal tool failure the agent recovers from by navigating fresh — rather
// than the Playwright "target closed" message that would land here).

export function isBrowserInfraError(error?: string): boolean {
  if (!error) return false;
  const lower = error.toLowerCase();
  return INFRA_ERROR_SIGNATURES.some((s) => lower.includes(s));
}

/**
 * A browser tool whose infrastructure failure ends the run instead of feeding an escalation
 * ladder: sixty steps of retrying a dead sidecar cost minutes and teach the model nothing. The
 * failure is recorded for the caller and the model is told to stop.
 */
export function guardedBrowserTool(tool: Tool): Tool {
  return {
    ...tool,
    async execute(args, onProgress): Promise<ToolResult> {
      const result = await tool.execute(args, onProgress);
      if (result.success || !isBrowserInfraError(result.error)) return result;
      const sessionId = typeof args["__sessionId"] === "string" ? args["__sessionId"] : "";
      if (sessionId) recordBrowserOutcome(sessionId, { infraError: result.error });
      return {
        ...result,
        error: `Browser infrastructure is unavailable (${result.error}). Stop here: do not retry, reply with what you did so far.`,
      };
    },
  };
}

/**
 * The end of a browsing task, as a tool rather than as prose, because two things about it are
 * routed rather than read: a human handoff and the summary the caller keeps.
 */
export function createBrowserDoneTool(): Tool {
  return {
    name: "browser_done",
    description: "Signal that the task is finished. Set needs_human=true only if you are blocked by something you cannot resolve yourself (CAPTCHA, bot-check, 2FA/OTP). After calling it, reply with the summary as your final message.",
    parameters: {
      type: "object",
      properties: {
        summary: { type: "string", description: "Summary of what was done, or what is blocking" },
        needs_human: { type: "boolean", description: "True if a human must take over the live browser to resolve a blocker" },
      },
      required: ["summary"],
    },
    async execute(args): Promise<ToolResult> {
      const sessionId = typeof args["__sessionId"] === "string" ? args["__sessionId"] : "";
      const summary = typeof args["summary"] === "string" ? args["summary"] : "done";
      const needsHuman = args["needs_human"] === true;
      if (sessionId) recordBrowserOutcome(sessionId, { summary, needsHuman });
      return {
        success: true,
        output: needsHuman
          ? "Recorded: a human must take over. Reply now with what is blocking, in one short paragraph, and stop."
          : "Recorded. Reply now with that summary as your final message, without calling more tools.",
      };
    },
  };
}
