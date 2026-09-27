import { BrowserCast } from "../../browser/cast.ts";
import { BrowserClient } from "../../browser/client.ts";
import type { MyClawConfig } from "../../core/config.ts";
import { type Tool, type ToolResult } from "../types.ts";
import { BrowserWindows, taskLabel } from "./windows.ts";

export const DEFAULT_NOVNC_URL = "http://localhost:6080";
export const DEFAULT_SIDECAR_URL = "http://127.0.0.1:9223";

/**
 * The one browser, as the tools see it: one client for every run, and the windows those runs hold.
 *
 * Runs are not queued. Each works in windows of its own, taken by the first tool that names a free
 * one and given back when the run ends, so any number of them drive the one Chromium at once
 * without sharing a tab -- docs/browser-windows.md.
 */
export class BrowserSession {
  readonly client: BrowserClient;
  readonly windows: BrowserWindows;
  /** The live pictures the owner's devices watch -- docs/browser-live.md. */
  readonly cast: BrowserCast;

  constructor(private config: MyClawConfig) {
    this.client = new BrowserClient(this.sidecarUrl(), config.browser?.viewport, config.browser?.timeoutsMs);
    this.windows = new BrowserWindows(this.client);
    this.cast = new BrowserCast(() => this.sidecarUrl());
    this.client.keepOpenWhen((pageId) => this.windows.keptForHuman(pageId));
  }

  sidecarUrl(): string {
    return this.config.browser?.sidecarUrl ?? DEFAULT_SIDECAR_URL;
  }

  /** A browser run starts: the live config reaches the client, and the run gets an empty set of windows. */
  beginRun(sessionId: string, parentSessionId?: string, task?: string): void {
    this.client.reconfigure(this.sidecarUrl(), this.config.browser?.viewport, this.config.browser?.timeoutsMs);
    this.windows.beginRun(sessionId, parentSessionId, taskLabel(task));
  }

  /**
   * A browser run is over, however it ended. A human handoff keeps its windows for its conversation
   * and puts the one it worked in last on the VNC screen, where the human is about to look.
   */
  async endRun(sessionId: string): Promise<void> {
    const handoff = outcomes.get(sessionId)?.needsHuman === true;
    const shown = this.windows.endRun(sessionId, handoff);
    if (shown === undefined) return;
    try {
      await this.client.stage(shown);
      recordBrowserOutcome(sessionId, { onScreen: this.windows.aliasOf(shown) });
    } catch {
      // The screen stays as it was: the handoff message then names no window, and the owner picks
      // one from the app.
    }
  }

  /**
   * The windows and tabs of the shared browser, as a section of the task: where to work is the
   * first decision of a run, and it has to be made from what is open, not from a tool the agent
   * would have to think of calling first.
   */
  async describeWindows(): Promise<string> {
    try {
      return await this.windows.describe();
    } catch {
      return "## Browser windows\n(could not read the browser's windows: browser_list_windows will retry)";
    }
  }
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
  /** The window put on the VNC screen for the human, by the number agents use. */
  onScreen?: number;
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
