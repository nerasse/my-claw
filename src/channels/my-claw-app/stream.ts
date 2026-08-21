import { currentRunId } from "../../utils/run-context.ts";
import { stripMediaRefsStreaming } from "../../utils/media.ts";
import type { ToolCallInfo, ToolCallResult } from "../../agent/tool-status.ts";
import type { MyClawAppServerFrame } from "./types.ts";

/** Tool output is a debugging view, not context: cap it so a 2 MB result never hits the socket. */
export const TOOL_OUTPUT_LIMIT = 4000;

export interface MyClawAppStreamerOptions {
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
  private pendingToolIds: string[] = [];
  /** Model tool_use id -> card id (set at start), so live-progress frames find the card. */
  private toolIdsByModelId = new Map<string, string>();
  /** subagentId -> the spawn card id (tool-start card for tool spawns, else the subagent id). */
  private spawnCardIds = new Map<string, string>();
  private started = false;
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
   *  matching `chat.tool` frame settles it. Throttled upstream (the tool batches), so this does
   *  not coalesce. */
  async appendToolProgress(toolCallId: string, chunk: { stdout?: string; stderr?: string }): Promise<void> {
    const stdout = chunk.stdout ?? "";
    const stderr = chunk.stderr ?? "";
    if (!stdout && !stderr) return;
    return this.enqueue(async () => {
      if (this.finished) return;
      // The hook carries the model's tool_use id; the card's id is the start's. Look it up so the
      // app appends to the right card.
      const id = this.toolIdsByModelId.get(toolCallId) ?? toolCallId;
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
   * spawn card for a programmatic spawn (`send()`) that has no tool call.
   */
  async appendSpawnStart(info: {
    subagentId: string;
    displayName: string;
    type: string;
    mode: string;
    toolCallId?: string;
  }): Promise<void> {
    return this.enqueue(async () => {
      if (this.finished) return;
      // Link to the tool-start card when the spawn came from a tool call; else the sub-agent id is
      // the card id so a later end frame settles the same card.
      const cardId = (info.toolCallId && this.toolIdsByModelId.get(info.toolCallId)) || info.subagentId;
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
      const cardId = this.spawnCardIds.get(info.subagentId) ?? ((info.toolCallId && this.toolIdsByModelId.get(info.toolCallId)) || info.subagentId);
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


  private currentId(): string {
    return this.segment === 0 ? this.opts.id : `${this.opts.id}#${this.segment}`;
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => {});
    return run;
  }

  private async startSegment(): Promise<void> {
    this.started = true;
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
    });
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
      // stacking a second one. When no start was sent (a replayed session written before starts,
      // or a non-verbose channel), fall back to the turn-scoped counter.
      const startId = this.pendingToolIds.shift();
      const id = tool.id ?? startId ?? (() => { this.toolCount += 1; return `${this.opts.id}:tool:${this.toolCount}`; })();
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
      const id = `${this.opts.id}:tool:${this.toolCount}`;
      this.pendingToolIds.push(id);
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
    await this.opts.send({ type: "chat.stream.abort", id: this.currentId(), threadId: this.opts.threadId, error: err || undefined });
  }
}
