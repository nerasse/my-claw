import { currentRunId } from "../../utils/run-context.ts";
import { newEntryId } from "../../sessions/log.ts";
import { stripMediaRefsStreaming } from "../../utils/media.ts";
import type { ToolCallInfo, ToolCallResult } from "../../agent/tool-status.ts";
import { toolCardId } from "./types.ts";
import type { MyClawAppServerFrame, MyClawAppSpawnAction } from "./types.ts";

/** Tool output is a debugging view, not context: cap it so a 2 MB result never hits the socket. */
export const TOOL_OUTPUT_LIMIT = 4000;

export interface MyClawAppStreamerOptions {
  /**
   * The first bubble's id. An entry id, minted by the caller: the phase the log keeps of this
   * bubble is appended under it, so the bubble on screen and the entry behind it are one identity
   * -- docs/bubble-identity.md.
   */
  id: string;
  threadId: string;
  replyToId?: string;
  send: (frame: MyClawAppServerFrame) => Promise<void> | void;
  /** Full text length at which the first delta is pushed. Defaults to 1 (start as soon as text exists). */
  minCharsBeforeDelta?: number;
}

/**
 * Owns the output bubbles of one run. Text accumulates into a bubble until a tool runs: the
 * bubble is then sealed and the following text opens a new one, so the client renders
 * text -> tool cards -> text in order instead of one bubble with notes glued inside.
 */
export class MyClawAppStreamer {
  private segmentText = "";
  /** Visible text already sent for the current segment; the next delta is the diff, since the
   *  device accumulates what it receives. Held-back ref fragments never count as sent. */
  private emittedText = "";
  private segment = 0;
  private toolCount = 0;
  /** Ids of started-but-not-yet-ended tool calls, so the end frame reuses the start's id. */
  /** Tool cards opened by `chat.tool.start` and not yet settled, with what the start sent so an
   *  abort can settle them with their real name/args instead of blanking the card. */
  private pendingToolIds: Array<{ id: string; name: string; args: Record<string, unknown> }> = [];
  /** Model tool_use id -> card id (set at start), so live-progress frames find the card. */
  private toolIdsByModelId = new Map<string, string>();
  /** subagentId -> the spawn card id (tool-start card for tool spawns, else the subagent id). */
  private spawnCardIds = new Map<string, string>();
  /** Bubble id per segment, minted on first use. */
  private segmentIds: string[] = [];
  /** ISO instant the open thinking phase began, while one is open -- see `openSpan`. */
  private reasoningSince: string | undefined;
  /** Bubble ids not yet taken by the recorder, oldest first. */
  private unclaimed: string[] = [];
  private errorBubbleId: string | undefined;
  private started = false;
  /**
   * Whether anything of this streamer ever reached a screen. Not the same as `started`, which is
   * "a bubble is open right now" and goes back to false at every seal: this one never goes back.
   */
  private painted = false;
  private finished = false;
  private queue: Promise<void> = Promise.resolve();

  constructor(private opts: MyClawAppStreamerOptions) {}

  async push(token: string): Promise<void> {
    if (!token) return;
    return this.enqueue(() => this.pushInternal(token));
  }

  /**
   * Reasoning text for the current bubble. It opens the bubble on its own: the thinking phase is
   * exactly the silence the owner stares at, so it must be visible before the first word of the
   * answer -- docs/reasoning-visibility.md.
   */
  async pushReasoning(delta: string): Promise<void> {
    if (!delta) return;
    return this.enqueue(() => this.reasoningInternal(delta));
  }

  /** Token estimate from a redacted engine; opens the bubble for the same reason. */
  async pushReasoningTokens(tokens: number): Promise<void> {
    if (!Number.isFinite(tokens) || tokens <= 0) return;
    return this.enqueue(() => this.reasoningTokensInternal(tokens));
  }

  async finish(finalText?: string): Promise<void> {
    return this.enqueue(() => this.finishInternal(finalText));
  }

  async abort(errorText?: string): Promise<void> {
    return this.enqueue(() => this.abortInternal(errorText));
  }

  async appendToolUse(toolCalls: ToolCallResult[], verbose: boolean): Promise<void> {
    if (!verbose || toolCalls.length === 0) return;
    return this.enqueue(() => this.toolInternal(toolCalls));
  }

  async appendToolStart(toolCalls: ToolCallInfo[]): Promise<void> {
    if (toolCalls.length === 0) return;
    return this.enqueue(() => this.toolStartInternal(toolCalls));
  }

  /** Live output from a running tool (bash). Appends to the card the start frame opened; the
   *  matching `chat.tool` frame settles it. Throttled by the caller, so this does not coalesce. */
  async appendToolProgress(toolCallId: string, chunk: { stdout?: string; stderr?: string }): Promise<void> {
    const stdout = chunk.stdout ?? "";
    const stderr = chunk.stderr ?? "";
    if (!stdout && !stderr) return;
    return this.enqueue(async () => {
      if (this.finished) return;
      // The hook carries the model's tool_use id; the card's id is derived from it. Derived, not
      // looked up: the table is per streamer, and a mid-run injection builds a fresh one, so a
      // lookup silently fell back to the raw model id -- output addressed to a card that does not
      // exist, and a journal that never forgets it on settle. One card, one id.
      const id = toolCardId(toolCallId) ?? this.toolIdsByModelId.get(toolCallId) ?? toolCallId;
      await this.opts.send({
        type: "chat.tool.delta",
        id,
        threadId: this.opts.threadId,
        turnId: this.opts.id,
        stdout,
        stderr,
        ts: new Date().toISOString(),
      });
    });
  }

  /**
   * A sub-agent spawned mid-run. Annotates the `spawn` tool card the start frame already opened
   * (linked by toolCallId) with its sub-agent identity and running state, or opens a standalone
   * spawn card when there is no tool call to annotate.
   */
  async appendSpawnStart(info: {
    subagentId: string;
    displayName: string;
    type: string;
    mode: string;
    action: MyClawAppSpawnAction;
    toolCallId?: string;
  }): Promise<void> {
    return this.enqueue(async () => {
      if (this.finished) return;
      // Link to the tool-start card when the spawn came from a tool call; else the sub-agent id is
      // the card id so a later end frame settles the same card.
      // Looked up, not derived, unlike a tool's live output: here the question is whether a tool
      // card EXISTS to link to. A programmatic spawn, or one whose card was suppressed, must fall
      // back to the sub-agent id -- deriving `t-<toolu>` would name a card nobody drew.
      const cardId = (info.toolCallId ? this.toolIdsByModelId.get(info.toolCallId) : undefined) ?? info.subagentId;
      this.spawnCardIds.set(info.subagentId, cardId);
      await this.opts.send({
        type: "chat.spawn.start",
        id: cardId,
        subagentId: info.subagentId,
        threadId: this.opts.threadId,
        turnId: this.opts.id,
        displayName: info.displayName,
        agentType: info.type,
        mode: info.mode,
        action: info.action,
        ts: new Date().toISOString(),
      });
    });
  }

  /** Settles a spawn card: complete, error, or aborted. */
  async appendSpawnEnd(info: {
    subagentId: string;
    status: "complete" | "error" | "aborted";
    toolCallId?: string;
    resultLength?: number;
    error?: string;
  }): Promise<void> {
    return this.enqueue(async () => {
      if (this.finished) return;
      const cardId = this.spawnCardIds.get(info.subagentId) ?? (info.toolCallId ? this.toolIdsByModelId.get(info.toolCallId) : undefined) ?? info.subagentId;
      this.spawnCardIds.delete(info.subagentId);
      await this.opts.send({
        type: "chat.spawn.end",
        id: cardId,
        subagentId: info.subagentId,
        threadId: this.opts.threadId,
        turnId: this.opts.id,
        status: info.status,
        ...(info.resultLength !== undefined ? { resultLength: info.resultLength } : {}),
        ...(info.error ? { error: info.error } : {}),
        ts: new Date().toISOString(),
      });
    });
  }


  /**
   * The bubble ids opened and not yet claimed. The recorder takes them when the model call
   * returns and appends its phases under them, which is what makes the two the same thing.
   */
  take(): string[] {
    const ids = this.unclaimed;
    this.unclaimed = [];
    return ids;
  }

  /** The bubble an abort painted the error in, once one has. */
  errorBubble(): string | undefined {
    return this.errorBubbleId;
  }

  private currentId(): string {
    // A segment is a bubble, and a bubble is an entry waiting to be written: its id is minted here
    // rather than derived from the run's, because a derived `id#2` is not something the log can
    // carry, and an entry the log minted separately is a second identity for one piece of prose.
    const existing = this.segmentIds[this.segment];
    if (existing) return existing;
    const id = this.segment === 0 ? this.opts.id : newEntryId();
    this.segmentIds[this.segment] = id;
    this.unclaimed.push(id);
    return id;
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => {});
    return run;
  }

  private async startSegment(): Promise<void> {
    this.started = true;
    this.painted = true;
    await this.opts.send({
      type: "chat.stream.start",
      id: this.currentId(),
      threadId: this.opts.threadId,
      replyToId: this.segment === 0 ? this.opts.replyToId : undefined,
      ...(currentRunId() ? { run: currentRunId() } : {}),
    });
  }

  private async pushInternal(token: string): Promise<void> {
    if (this.finished) return;
    this.segmentText += token;

    if (!this.started) {
      if (this.segmentText.trim().length < (this.opts.minCharsBeforeDelta ?? 1)) return;
      // The whole buffer, not the token that crossed the threshold: everything accumulated
      // while waiting is text the reader never saw. Sending only the last token dropped the
      // opening words of every reply, and the bubble read as if it started mid-sentence --
      // invisible on the server, which stores the full turn and replays it complete.
      await this.startSegment();
      await this.emitDelta();
      return;
    }

    await this.emitDelta();
  }

  private async reasoningInternal(delta: string): Promise<void> {
    if (this.finished) return;
    await this.sealBeforeReasoning();
    // No ceiling: a thought that stops mid-sentence is worse than a long one, and this text never
    // goes back to the model, so its only cost is the bytes it occupies.
    // Never gated by minCharsBeforeDelta: withholding the thinking to reach a character
    // threshold would defeat the point of showing it.
    if (!this.started) await this.startSegment();
    await this.opts.send({
      type: "chat.reasoning.delta",
      id: this.currentId(),
      threadId: this.opts.threadId,
      text: delta,
      ...this.openSpan(),
    });
  }

  private async reasoningTokensInternal(tokens: number): Promise<void> {
    if (this.finished) return;
    await this.sealBeforeReasoning();
    if (!this.started) await this.startSegment();
    await this.opts.send({
      type: "chat.reasoning.tokens",
      id: this.currentId(),
      threadId: this.opts.threadId,
      tokens,
      ...this.openSpan(),
    });
  }

  /**
   * Opens the thinking span if none is open, and answers the instant for the frame that opens it.
   *
   * The instant travels rather than an elapsed time, like `chat.compacting` does: the client turns
   * it into a counter, and a window reloading mid-thought is replayed that same opening frame
   * (`live-turn.ts` merges a subject's deltas onto its first one), so the span it draws is the one
   * that has been running rather than a fresh zero.
   *
   * Only the opening frame carries it. The ones that follow would move the start of a span still
   * running, and the phase ends where the segmenter ends it: the seal, which is what clears this.
   */
  private openSpan(): { since?: string } {
    if (this.reasoningSince !== undefined) return {};
    this.reasoningSince = new Date().toISOString();
    return { since: this.reasoningSince };
  }

  /**
   * Thinking that follows an answer belongs to the next bubble. Attached to the open one it would
   * render above text the reader has already read, and the words that come after it would continue
   * that same bubble -- so a second thinking phase rewrote the first answer's header. The stored
   * mirror already splits there (one assistant message per turn, its estimate taken from the
   * thinking that preceded it), so sealing here is what makes the live stream match the replay.
   */
  private async sealBeforeReasoning(): Promise<void> {
    if (!this.started || this.emittedText.length === 0) return;
    await this.sealSegment();
  }

  /** Closes the open bubble and moves to the next one; the buffers belong to the segment. */
  private async sealSegment(): Promise<void> {
    if (this.started) {
      await this.opts.send({ type: "chat.stream.done", id: this.currentId(), threadId: this.opts.threadId });
      this.started = false;
      this.segment += 1;
    }
    this.segmentText = "";
    this.emittedText = "";
    // The thinking span belongs to the bubble that was sealed: the next thought is another phase,
    // and it opens its own.
    this.reasoningSince = undefined;
  }

  /** Sends what is newly visible after stripping, holding back an incomplete MEDIA: ref. */
  private async emitDelta(): Promise<void> {
    const visible = stripMediaRefsStreaming(this.segmentText);
    if (visible.length <= this.emittedText.length) return;
    await this.opts.send({
      type: "chat.stream.delta",
      id: this.currentId(),
      threadId: this.opts.threadId,
      text: visible.slice(this.emittedText.length),
    });
    this.emittedText = visible;
  }

  private async toolInternal(toolCalls: ToolCallResult[]): Promise<void> {
    if (this.finished) return;
    await this.sealSegment();
    for (const tool of toolCalls) {
      // Reuse the id the start frame sent so the app upserts the card with the result instead of
      // stacking a second one. The model's tool_use id is only a fallback: when no start was sent
      // (a replayed session written before starts), it is absent anyway and we fall back to the
      // turn-scoped counter.
      // `toolCardId`, not the raw `tool.id`: the fallback has to mint the id the start frame and
      // the history builder would have, or the card it lands on is a third one again.
      // By id first: tools are flushed as they finish, so the order results arrive in is the order
      // the work ended, not the order it was asked for -- `shift()` would settle the first card
      // with whichever tool spoke first, and leave the card of a finished tool spinning
      // (2026-09-16). The shift stays for a provider that sends no tool_use id at all.
      const wanted = tool.id ? this.toolIdsByModelId.get(tool.id) : undefined;
      const at = wanted ? this.pendingToolIds.findIndex((pending) => pending.id === wanted) : -1;
      const startId = (at !== -1 ? this.pendingToolIds.splice(at, 1)[0]!.id : undefined)
        ?? this.pendingToolIds.shift()?.id
        ?? toolCardId(tool.id)
        ?? (() => { this.toolCount += 1; return `${this.opts.id}:tool:${this.toolCount}`; })();
      const id = startId;
      const output = tool.output ?? "";
      const truncated = output.length > TOOL_OUTPUT_LIMIT;
      await this.opts.send({
        type: "chat.tool",
        id,
        threadId: this.opts.threadId,
        turnId: this.opts.id,
        name: tool.name,
        args: tool.arguments,
        durationMs: tool.durationMs,
        ok: tool.ok !== false,
        output: truncated ? output.slice(0, TOOL_OUTPUT_LIMIT) : output,
        truncated,
        ts: new Date().toISOString(),
      });
    }
  }

  private async toolStartInternal(toolCalls: ToolCallInfo[]): Promise<void> {
    if (this.finished) return;
    await this.sealSegment();
    for (const tool of toolCalls) {
      this.toolCount += 1;
      // The model's own call id when it gave one, so history rebuilds the same card rather than a
      // second one beside it. The counter stays as the fallback for a provider that sends none.
      const id = toolCardId(tool.id) ?? `${this.opts.id}:tool:${this.toolCount}`;
      this.pendingToolIds.push({ id, name: tool.name, args: tool.arguments });
      // Map the model's tool_use id to this card's id so live-progress frames (which carry the
      // model id) can find the card the start opened.
      if (tool.id) this.toolIdsByModelId.set(tool.id, id);
      await this.opts.send({
        type: "chat.tool.start",
        id,
        threadId: this.opts.threadId,
        turnId: this.opts.id,
        name: tool.name,
        args: tool.arguments,
        ts: new Date().toISOString(),
      });
    }
  }


  private async finishInternal(finalText?: string): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    // A run can exit through `finish` after a silent stop (the router swallows the abort and
    // returns undefined instead of throwing, so the caller never reaches abort()). Tool cards
    // left open by the stop would spin forever: settle them as interrupted here, exactly like
    // abortInternal does, so both exit paths leave the same clean state.
    if (this.pendingToolIds.length > 0) {
      for (const pending of this.pendingToolIds) {
        await this.opts.send({
          type: "chat.tool",
          id: pending.id,
          threadId: this.opts.threadId,
          turnId: this.opts.id,
          name: pending.name,
          args: pending.args,
          ok: false,
          output: "interrupted",
          truncated: false,
          ts: new Date().toISOString(),
        });
      }
      this.pendingToolIds = [];
    }
    if (this.spawnCardIds.size > 0) {
      for (const [subagentId, cardId] of this.spawnCardIds) {
        await this.opts.send({
          type: "chat.spawn.end",
          id: cardId,
          subagentId,
          threadId: this.opts.threadId,
          turnId: this.opts.id,
          status: "aborted",
          ts: new Date().toISOString(),
        });
      }
      this.spawnCardIds = new Map();
    }
    const pending = finalText ?? this.segmentText;
    const text = stripMediaRefsStreaming(pending);

    if (!this.started && text.trim().length > 0) {
      await this.startSegment();
      await this.opts.send({ type: "chat.stream.delta", id: this.currentId(), threadId: this.opts.threadId, text });
    }
    await this.opts.send({ type: "chat.stream.done", id: this.currentId(), threadId: this.opts.threadId });
  }

  private async abortInternal(errorText?: string): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    const err = errorText?.trim();
    // Nothing was ever painted and there is nothing to report: say nothing. `chat.stream.abort`
    // for an id the app never saw is materialized there as an empty bubble carrying the error,
    // which is how one `/stop` printed "Run aborted by user" once per message folded into the run:
    // each of those messages has a streamer of its own, unused, because the run answered them in
    // its own bubbles. An error is the exception -- with no bubble to carry it, that invented
    // bubble is the only place the owner can read it before the next history load.
    if (!this.painted && !err && this.pendingToolIds.length === 0 && this.spawnCardIds.size === 0) {
      return;
    }
    // A run can die with tool cards still open (the model asked, the stop cut it before the tool
    // answered, or a spawn was cut mid-run). The start frames opened those cards with `running:
    // true`; without a settle they would spin forever. Settle every pending tool card as a failed
    // call, then every live spawn card as aborted, in the same format the natural end uses so the
    // app upserts rather than stacks.
    for (const pending of this.pendingToolIds) {
      await this.opts.send({
        type: "chat.tool",
        id: pending.id,
        threadId: this.opts.threadId,
        turnId: this.opts.id,
        name: pending.name,
        args: pending.args,
        ok: false,
        output: err ? `aborted: ${err}` : "aborted",
        truncated: false,
        ts: new Date().toISOString(),
      });
    }
    this.pendingToolIds = [];
    // A spawn annotated via appendSpawnStart may or may not have a tool card; settle the annotated
    // card (or the standalone one, which uses the subagent id as its card id).
    for (const [subagentId, cardId] of this.spawnCardIds) {
      await this.opts.send({
        type: "chat.spawn.end",
        id: cardId,
        subagentId,
        threadId: this.opts.threadId,
        turnId: this.opts.id,
        status: "aborted",
        ...(err ? { error: err } : {}),
        ts: new Date().toISOString(),
      });
    }
    this.spawnCardIds = new Map();
    const bubble = this.currentId();
    // The bubble the error is shown in, so the `failure` entry can be journalled under the same
    // id -- docs/bubble-identity.md. Minted here when the run died before its first token, and
    // then this is the only place that knows it: the app invents the bubble from this very frame.
    this.errorBubbleId = bubble;
    await this.opts.send({ type: "chat.stream.abort", id: bubble, threadId: this.opts.threadId, error: err || undefined });
  }
}
