import { currentRunId } from "../../utils/run-context.ts";
import type { ToolCallResult } from "../../agent/tool-status.ts";
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
  private segment = 0;
  private toolCount = 0;
  private started = false;
  private finished = false;
  private queue: Promise<void> = Promise.resolve();

  constructor(private opts: MyClawAppStreamerOptions) {}

  async push(token: string): Promise<void> {
    if (!token) return;
    return this.enqueue(() => this.pushInternal(token));
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
      await this.opts.send({
        type: "chat.stream.delta",
        id: this.currentId(),
        threadId: this.opts.threadId,
        text: this.segmentText,
      });
      return;
    }

    await this.opts.send({ type: "chat.stream.delta", id: this.currentId(), threadId: this.opts.threadId, text: token });
  }

  private async toolInternal(toolCalls: ToolCallResult[]): Promise<void> {
    if (this.finished) return;
    if (this.started) {
      await this.opts.send({ type: "chat.stream.done", id: this.currentId(), threadId: this.opts.threadId });
      this.started = false;
      this.segment += 1;
    }
    this.segmentText = "";
    for (const tool of toolCalls) {
      this.toolCount += 1;
      const output = tool.output ?? "";
      const truncated = output.length > TOOL_OUTPUT_LIMIT;
      await this.opts.send({
        type: "chat.tool",
        id: `${this.opts.id}:tool:${this.toolCount}`,
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

  private async finishInternal(finalText?: string): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    const pending = finalText ?? this.segmentText;

    if (!this.started && pending.trim().length > 0) {
      await this.startSegment();
      await this.opts.send({ type: "chat.stream.delta", id: this.currentId(), threadId: this.opts.threadId, text: pending });
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
