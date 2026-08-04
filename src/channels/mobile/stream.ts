import { formatToolStatusVerbose, formatToolStatusCompact } from "../../agent/tool-status.ts";
import type { MobileServerFrame } from "./types.ts";

export interface MobileStreamerOptions {
  id: string;
  replyToId?: string;
  send: (frame: MobileServerFrame) => Promise<void> | void;
  /** Full text length at which the first delta is pushed. Defaults to 1 (start as soon as text exists). */
  minCharsBeforeDelta?: number;
}

export class MobileStreamer {
  private fullText = "";
  private started = false;
  private finished = false;
  private queue: Promise<void> = Promise.resolve();

  constructor(private opts: MobileStreamerOptions) {}

  async push(token: string): Promise<void> {
    if (!token) return;
    return this.enqueue(() => this.pushInternal(token));
  }

  async finish(finalText = this.fullText): Promise<void> {
    return this.enqueue(() => this.finishInternal(finalText));
  }

  async abort(errorText?: string): Promise<void> {
    return this.enqueue(() => this.abortInternal(errorText));
  }

  async appendToolUse(toolCalls: Array<{ name: string; arguments: Record<string, unknown>; durationMs: number }>, verbose: boolean): Promise<void> {
    const note = verbose ? formatToolStatusVerbose(toolCalls) : formatToolStatusCompact(toolCalls);
    if (!note) return;
    return this.enqueue(() => this.pushInternal(note));
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => {});
    return run;
  }

  private async pushInternal(token: string): Promise<void> {
    if (this.finished) return;
    this.fullText += token;

    if (!this.started && this.fullText.trim().length >= (this.opts.minCharsBeforeDelta ?? 1)) {
      this.started = true;
      await this.opts.send({
        type: "chat.stream.start",
        id: this.opts.id,
        replyToId: this.opts.replyToId,
      });
    }
    if (!this.started) return;

    await this.opts.send({ type: "chat.stream.delta", id: this.opts.id, text: token });
  }

  private async finishInternal(finalText: string): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    this.fullText = finalText;

    if (!this.started && this.fullText.trim().length >= (this.opts.minCharsBeforeDelta ?? 1)) {
      this.started = true;
      await this.opts.send({
        type: "chat.stream.start",
        id: this.opts.id,
        replyToId: this.opts.replyToId,
      });
      await this.opts.send({ type: "chat.stream.delta", id: this.opts.id, text: finalText });
    }
    await this.opts.send({ type: "chat.stream.done", id: this.opts.id });
  }

  private async abortInternal(errorText?: string): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    const err = errorText?.trim();
    await this.opts.send({ type: "chat.stream.abort", id: this.opts.id, error: err || undefined });
  }
}
