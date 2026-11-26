import type { UnifiedMessage } from "../types.ts";
import type { MyClawAppStreamer } from "./stream.ts";
import { subAgentStreamFor } from "./subagent-stream.ts";
import type { SubAgentStream } from "../../subagents/runner.ts";

/**
 * A sub-agent's live stream, from the child's run instead of the turn that launched it.
 *
 * A launch never waits: the spawning turn answers in milliseconds and the child carries on by
 * design (docs/subagents.md, "Background"). The stream used to be opened and torn down with that
 * turn, so the moment the parent answered, the child's thread stopped receiving frames and its
 * run was announced `aborted` although it was still working. The stop pressed on that thread then
 * had no end left to report, so the chat said "stopped" under a button that spun for good, and a
 * window that opened mid-run was replayed nothing at all (owner, 2026-11-26).
 *
 * So this owns the whole lifecycle, once for the process, for every depth: the stream opens with
 * the child's run and closes with the child's own end, whether its parent is a conversation or
 * another sub-agent. The launch card still lands on the *parent's* bubble, which is why the
 * parent's own streamer is registered here too.
 *
 * Deliberately not a hook subscriber: the entry point wires `subagent:spawn` and its ends to
 * `spawn`/`settle`, so what this does can be tested without a running engine.
 */
export interface SubAgentLiveDeps {
  /** The app's own streamer factory: one bubble sequence, addressed by the message's thread. */
  createStreamer: (message: UnifiedMessage) => MyClawAppStreamer;
  /** Announces a child run on its thread -- the live journal a reloading window is replayed from. */
  notifyRun: (owner: string, threadId: string, active: boolean, reason?: "done" | "aborted" | "error") => void;
  /** The app conversation behind a session id, or null when the session is another channel's. */
  appSessionOf: (sessionId: string) => { owner: string; threadId: string } | null;
  /** The thread handle a sub-agent session is addressed by. */
  threadOf: (subagentId: string) => string | null;
  /** The message:injected contract, for a child steered mid-run. */
  onInjected: (injected: UnifiedMessage, subagentId: string) => void;
}

/** What a spawn announces, as the hook carries it. */
export interface SubAgentSpawnEvent {
  id: string;
  displayName: string;
  type: string;
  mode: string;
  parentSessionId: string;
  toolCallId?: string;
  action: "spawn" | "send";
}

/** How a child's run ended, as the hook carries it. */
export type SubAgentEndStatus = "complete" | "error" | "aborted";

export class SubAgentLive {
  private deps?: SubAgentLiveDeps;
  /** The child streamer of each sub-agent, keyed by its session id. */
  private streamers = new Map<string, MyClawAppStreamer>();
  /** How to open a fresh bubble in a child's thread, for the turn that steers it. */
  private renews = new Map<string, (injected: UnifiedMessage) => MyClawAppStreamer>();
  /** The bubble an app run is painting into, by the session it answers: replaced on injection. */
  private runs = new Map<string, () => MyClawAppStreamer>();
  /**
   * The owner each sub-agent works for, by session id.
   *
   * A grandchild's parent is another sub-agent, which has no app session of its own, so the owner
   * is inherited the same way the run is: one level up, from a mapping that was recorded when that
   * level opened. Nobody else can name it -- the roster, the files and the live frames all address
   * a thread on behalf of this owner.
   */
  private owners = new Map<string, string>();

  /** One door at boot, because the adapter only exists once the channel starts. */
  attach(deps: SubAgentLiveDeps): void {
    this.deps = deps;
  }

  /** The child's streamer, for the bubble sink the run recorder takes its ids from. */
  streamerOf(subagentId: string): MyClawAppStreamer | undefined {
    return this.streamers.get(subagentId);
  }

  /**
   * What the spawn tool's stream provider reads. Undefined while the channel is down, and for a
   * child nobody paints: the run is then exactly what it was before streams existed.
   */
  streamOf(subagentId: string): SubAgentStream | undefined {
    if (!this.deps) return undefined;
    return subAgentStreamFor(this.streamers, this.renews, subagentId, (injected) =>
      this.deps?.onInjected(injected, subagentId));
  }

  /**
   * The bubble an app run paints into, for as long as that run lasts.
   *
   * A getter rather than the streamer: a mid-run injection replaces it, and a child announced
   * after that belongs on the bubble open now.
   */
  registerRun(sessionId: string, streamer: () => MyClawAppStreamer): () => void {
    const getter = streamer;
    this.runs.set(sessionId, getter);
    return () => {
      // Only this run's registration: a later run of the same session has its own getter, and
      // deleting on the strength of the id alone would blind it.
      if (this.runs.get(sessionId) === getter) this.runs.delete(sessionId);
    };
  }

  /** A child started working: its thread's run opens before its first frame. */
  spawn(ev: SubAgentSpawnEvent): void {
    this.open(ev);
    const card = {
      subagentId: ev.id,
      displayName: ev.displayName,
      type: ev.type,
      mode: ev.mode,
      action: ev.action,
      ...(ev.toolCallId ? { toolCallId: ev.toolCallId } : {}),
    };
    void this.parentStreamerOf(ev.parentSessionId)?.appendSpawnStart(card);
  }

  /**
   * A child's run settled: its stream closes, its card says how, and its thread's run ends.
   *
   * One door for every end -- complete, error, aborted, killed, reset -- because the thread has one
   * run and every one of them leaves it in the same place: nothing is coming after, so the app
   * must be told or its Stop button and its timer never stop.
   *
   * **The end is the last frame of the run, and this awaits everything before it.** A stop settles
   * the interrupted tool card and the bubble's abort after the run was declared over used to draw
   * a card on a thread whose run had just ended, and the app opens a run for any item it meets
   * outside one -- a synthetic run nothing would ever end, so the Stop button came back and stayed
   * (measured 2026-11-26: `chat.run.end` then `chat.tool` and `chat.stream.abort` in the same
   * millisecond, and the composer span for three minutes).
   */
  async settle(ev: { id: string; parentSessionId: string; error?: unknown; resultLength?: number }, status: SubAgentEndStatus): Promise<void> {
    const card = {
      subagentId: ev.id,
      status,
      ...(ev.resultLength !== undefined ? { resultLength: ev.resultLength } : {}),
      ...(ev.error !== undefined ? { error: String(ev.error) } : {}),
    };
    await this.parentStreamerOf(ev.parentSessionId)?.appendSpawnEnd(card);

    const streamer = this.streamers.get(ev.id);
    this.streamers.delete(ev.id);
    this.renews.delete(ev.id);
    if (streamer) {
      if (status === "complete") await streamer.finish();
      else await streamer.abort(ev.error !== undefined ? String(ev.error) : undefined);
    }
    const owner = this.owners.get(ev.id);
    const threadId = this.deps?.threadOf(ev.id);
    if (owner && threadId) {
      this.deps?.notifyRun(owner, threadId, false, status === "complete" ? "done" : status === "error" ? "error" : "aborted");
    }
  }

  /** Live output of a child's tool, routed by the session that produced it. */
  progress(toolCallId: string, sessionId: string, chunk: { stdout?: string; stderr?: string }): void {
    void this.streamers.get(sessionId)?.appendToolProgress(toolCallId, chunk);
  }

  private open(ev: { id: string; parentSessionId: string }): void {
    const deps = this.deps;
    if (!deps) return;
    const parent = deps.appSessionOf(ev.parentSessionId);
    const owner = parent?.owner ?? this.owners.get(ev.parentSessionId);
    const threadId = deps.threadOf(ev.id);
    if (!owner || !threadId) return;
    this.owners.set(ev.id, owner);
    if (this.streamers.has(ev.id)) return;
    deps.notifyRun(owner, threadId, true);
    this.streamers.set(ev.id, deps.createStreamer(this.message(owner, threadId)));
    // A steered child seals the bubble in flight and opens its next one where it belongs: the
    // reply to the message that steered it.
    this.renews.set(ev.id, (injected) => deps.createStreamer(this.message(owner, threadId, injected.id || undefined)));
  }

  /** The bubble a spawn card belongs on: the parent run's own, wherever in the tree it sits. */
  private parentStreamerOf(parentSessionId: string): MyClawAppStreamer | undefined {
    return this.runs.get(parentSessionId)?.() ?? this.streamers.get(parentSessionId);
  }

  private message(owner: string, threadId: string, replyToId?: string): UnifiedMessage {
    return {
      id: replyToId ?? "",
      platform: "my-claw-app",
      userId: owner,
      chatId: owner,
      chatType: "dm",
      text: "",
      attachments: [],
      isForwarded: false,
      threadId,
      raw: null,
    };
  }
}
