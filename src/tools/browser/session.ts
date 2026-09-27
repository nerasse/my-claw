import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BrowserCast } from "../../browser/cast.ts";
import { BrowserClient } from "../../browser/client.ts";
import { MY_CLAW_DIR, type MyClawConfig } from "../../core/config.ts";
import { writeJsonFileAtomicallySync } from "../../utils/atomic-write.ts";
import { formatDuration, parseDurationMs } from "../../utils/duration.ts";
import { type Tool, type ToolResult } from "../types.ts";
import {
  BrowserWindows,
  DEFAULT_HOLD_POLICY,
  taskLabel,
  type HoldPolicy,
  type HoldStore,
  type WindowHold,
} from "./windows.ts";

/** Kept windows survive a restart of my-claw: they are work waiting, not a run's lock. */
export function fileHoldStore(path = join(MY_CLAW_DIR, "browser", "holds.json")): HoldStore {
  return {
    load: () => {
      try {
        const data = JSON.parse(readFileSync(path, "utf8")) as { holds?: WindowHold[] };
        return Array.isArray(data.holds) ? data.holds : [];
      } catch {
        return [];
      }
    },
    save: (holds) => writeJsonFileAtomicallySync(path, { holds }, true),
  };
}

/** The config's hold settings, read live; an unreadable value falls back to its default. */
export function holdPolicyOf(config: MyClawConfig): HoldPolicy {
  const read = (value: string | number | undefined, fallback: number): number => {
    if (value === undefined) return fallback;
    try {
      return parseDurationMs(value);
    } catch {
      return fallback;
    }
  };
  const maxMs = read(config.browser?.holdMax, DEFAULT_HOLD_POLICY.maxMs);
  return {
    maxMs,
    defaultMs: Math.min(read(config.browser?.holdDefault, DEFAULT_HOLD_POLICY.defaultMs), maxMs),
    maxWindows: config.browser?.holdMaxWindows ?? DEFAULT_HOLD_POLICY.maxWindows,
  };
}

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

  constructor(private config: MyClawConfig, holdStore: HoldStore = fileHoldStore()) {
    this.client = new BrowserClient(this.sidecarUrl(), config.browser?.viewport, config.browser?.timeoutsMs);
    this.windows = new BrowserWindows(this.client, Date.now, holdStore, () => holdPolicyOf(this.config));
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
   * A browser run is over, however it ended. Asked to keep its windows (a human handoff, or
   * `browser_done(keep_window)`), they stay kept for its conversation; any other end gives them
   * back. A human handoff also puts the window it worked in last on the VNC screen, where the human
   * is about to look.
   */
  async endRun(sessionId: string): Promise<void> {
    const outcome = outcomes.get(sessionId);
    const keep = outcome?.needsHuman
      ? { reason: "human" as const, ...(outcome.keepMs !== undefined ? { ms: outcome.keepMs } : {}) }
      : outcome?.keepWindow
        ? { reason: "kept" as const, ...(outcome.keepMs !== undefined ? { ms: outcome.keepMs } : {}) }
        : undefined;
    const kept = this.windows.endRun(sessionId, keep);
    if (!kept) return;
    recordBrowserOutcome(sessionId, { kept: { windows: kept.windowIds.map((id) => this.windows.aliasOf(id)), until: kept.until } });
    if (!outcome?.needsHuman) return;
    const shown = kept.windowIds[0]!;
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
  async describeWindows(callerSessionId?: string): Promise<string> {
    try {
      return await this.windows.describe("", callerSessionId);
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
  /** The run asked to keep its windows for its conversation, though no human is needed. */
  keepWindow?: boolean;
  /** How long to keep them, when the run said (capped at `browser.holdMax`). */
  keepMs?: number;
  infraError?: string;
  /** The window put on the VNC screen for the human, by the number agents use. */
  onScreen?: number;
  /** The windows kept once the run ended, by the number agents use, and until when. */
  kept?: { windows: number[]; until: number };
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
export function createBrowserDoneTool(policy: () => HoldPolicy = () => DEFAULT_HOLD_POLICY, room: () => number = () => Infinity): Tool {
  return {
    name: "browser_done",
    description: "Signal that the task is finished. Set needs_human=true only if you are blocked by something you cannot resolve yourself (CAPTCHA, bot-check, 2FA/OTP). Set keep_window=true when you stop at a step the task will come back to in this same window (an e-mail code the caller has to fetch first, a form to finish later): the window is kept for the conversation that sent you, instead of being given back. After calling it, reply with the summary as your final message.",
    parameters: {
      type: "object",
      properties: {
        summary: { type: "string", description: "Summary of what was done, or what is blocking. When you keep the window, say which step it is waiting at and what is needed to continue." },
        needs_human: { type: "boolean", description: "True if a human must take over the live browser to resolve a blocker. Keeps the window too." },
        keep_window: { type: "boolean", description: "True to keep your windows for the conversation that sent you, so the next task it sends continues in them. No human needed." },
        hold: { type: "string", description: "How long to keep them: '30m', '72h', '3d'. Default and maximum are set by the owner (browser.holdDefault, browser.holdMax)." },
      },
      required: ["summary"],
    },
    async execute(args): Promise<ToolResult> {
      const sessionId = typeof args["__sessionId"] === "string" ? args["__sessionId"] : "";
      const summary = typeof args["summary"] === "string" ? args["summary"] : "done";
      const needsHuman = args["needs_human"] === true;
      const keepWindow = args["keep_window"] === true || (typeof args["hold"] === "string" && args["hold"].trim() !== "");
      let keepMs: number | undefined;
      const notes: string[] = [];
      if (typeof args["hold"] === "string" && args["hold"].trim() !== "") {
        try {
          keepMs = parseDurationMs(args["hold"]);
        } catch (err) {
          return { success: false, output: "", error: err instanceof Error ? err.message : String(err) };
        }
        const limits = policy();
        if (keepMs > limits.maxMs) {
          notes.push(`Kept for ${formatDuration(limits.maxMs)}, the owner's maximum, not ${formatDuration(keepMs)}.`);
          keepMs = limits.maxMs;
        }
      }
      if ((needsHuman || keepWindow) && room() <= 0) {
        notes.push("No window can be kept right now: the maximum number is already kept. Yours will be given back; say so in your summary.");
      }
      if (sessionId) {
        recordBrowserOutcome(sessionId, {
          summary,
          needsHuman,
          ...(keepWindow ? { keepWindow: true } : {}),
          ...(keepMs !== undefined ? { keepMs } : {}),
        });
      }
      const next = needsHuman
        ? "Recorded: a human must take over. Reply now with what is blocking, in one short paragraph, and stop."
        : keepWindow
          ? "Recorded: your window is kept for the conversation that sent you. Reply now with that summary as your final message, without calling more tools."
          : "Recorded. Reply now with that summary as your final message, without calling more tools.";
      return { success: true, output: [next, ...notes].join(" ") };
    },
  };
}
