import { markdownToTelegramHtml, stripHtml } from "./telegram-format.ts";
import { CHUNK_LIMIT, alignPlainTextChunks, splitHtmlChunks } from "./telegram-split.ts";

const MESSAGE_NOT_FOUND_RE = /message to edit not found|message can't be edited|MESSAGE_ID_INVALID/i;

export interface StreamOptions {
  chatId: string;
  threadId?: number;
  replyToId?: number;
  minCharsBeforeSend?: number;
  editThrottleMs?: number;
  chunkLimit?: number;
}

export interface StreamTransport {
  sendPlain(
    chatId: string,
    text: string,
    opts: { threadId?: number; replyToId?: number },
  ): Promise<number>;
  editPlain(chatId: string, messageId: number, text: string): Promise<void>;
  sendFinal(
    chatId: string,
    html: string,
    plain: string,
    opts: { threadId?: number; replyToId?: number },
  ): Promise<number>;
  editFinal(chatId: string, messageId: number, html: string, plain: string): Promise<void>;
  deleteMessage?(chatId: string, messageId: number): Promise<void>;
}

function isMissingMessageError(err: unknown): boolean {
  return MESSAGE_NOT_FOUND_RE.test(String(err));
}

export class MessageStreamer {
  private fullText = "";
  private previewParts = [""];
  private messageIds: Array<number | null> = [null];
  private lastRenderedParts = [""];
  private lastEditAt = 0;
  private editTimer: ReturnType<typeof setTimeout> | null = null;
  private queue: Promise<void> = Promise.resolve();
  private finished = false;

  constructor(
    private opts: StreamOptions,
    private transport: StreamTransport,
  ) {}

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

  async forceNewMessage(): Promise<void> {
    return this.enqueue(async () => {
      if (this.finished) return;
      await this.flushCurrentPart(true);
      this.previewParts.push("");
      this.messageIds.push(null);
      this.lastRenderedParts.push("");
    });
  }

  async splitForToolUse(note = "Running tool..."): Promise<void> {
    return this.enqueue(async () => {
      if (this.finished) return;

      const index = this.currentIndex();
      const current = this.previewParts[index] ?? "";
      this.previewParts[index] = current ? `${current}\n\n${note}` : note;
      await this.flushCurrentPart(true);
      this.previewParts.push("");
      this.messageIds.push(null);
      this.lastRenderedParts.push("");
    });
  }

  private minCharsBeforeSend(): number {
    return this.opts.minCharsBeforeSend ?? 30;
  }

  private editThrottleMs(): number {
    return this.opts.editThrottleMs ?? 1000;
  }

  private chunkLimit(): number {
    return this.opts.chunkLimit ?? CHUNK_LIMIT;
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => {});
    return run;
  }

  private clearTimer(): void {
    if (this.editTimer) {
      clearTimeout(this.editTimer);
      this.editTimer = null;
    }
  }

  private currentIndex(): number {
    return this.previewParts.length - 1;
  }

  private async pushInternal(token: string): Promise<void> {
    if (this.finished) return;

    this.fullText += token;
    let remaining = token;

    while (remaining.length > 0) {
      const index = this.currentIndex();
      const current = this.previewParts[index] ?? "";
      const available = this.chunkLimit() - current.length;

      if (available <= 0) {
        await this.flushCurrentPart(true);
        this.previewParts.push("");
        this.messageIds.push(null);
        this.lastRenderedParts.push("");
        continue;
      }

      const slice = remaining.slice(0, available);
      this.previewParts[index] = current + slice;
      remaining = remaining.slice(slice.length);

      if ((this.previewParts[index]?.length ?? 0) >= this.chunkLimit() && remaining.length > 0) {
        await this.flushCurrentPart(true);
        this.previewParts.push("");
        this.messageIds.push(null);
        this.lastRenderedParts.push("");
      }
    }

    await this.scheduleCurrentPartEdit();
  }

  private async finishInternal(finalText: string): Promise<void> {
    if (this.finished) return;

    this.finished = true;
    this.fullText = finalText;
    this.clearTimer();

    const finalContent = finalText.trimEnd();
    if (!finalContent) {
      await this.deletePreviews();
      return;
    }

    const html = markdownToTelegramHtml(finalContent);
    const plain = stripHtml(html);
    const htmlChunks = splitHtmlChunks(html, this.chunkLimit());
    const plainChunks = alignPlainTextChunks(plain, htmlChunks.length, this.chunkLimit());

    for (let index = 0; index < htmlChunks.length; index++) {
      const htmlChunk = htmlChunks[index] ?? "";
      const plainChunk = plainChunks[index] ?? "";
      const messageId = this.messageIds[index];

      if (messageId !== null && messageId !== undefined) {
        try {
          await this.transport.editFinal(this.opts.chatId, messageId, htmlChunk, plainChunk);
          this.lastRenderedParts[index] = plainChunk;
          continue;
        } catch (err) {
          if (!isMissingMessageError(err)) throw err;
        }
      }

      this.messageIds[index] = await this.transport.sendFinal(this.opts.chatId, htmlChunk, plainChunk, {
        threadId: this.opts.threadId,
        replyToId: index === 0 ? this.opts.replyToId : undefined,
      });
      this.lastRenderedParts[index] = plainChunk;
    }

    if (this.transport.deleteMessage) {
      for (let index = htmlChunks.length; index < this.messageIds.length; index++) {
        const messageId = this.messageIds[index];
        if (messageId === null || messageId === undefined) continue;
        await this.transport.deleteMessage(this.opts.chatId, messageId).catch(() => {});
      }
    }
  }

  private async abortInternal(errorText?: string): Promise<void> {
    if (this.finished) return;

    this.finished = true;
    this.clearTimer();

    const text = errorText?.trim();
    if (text) {
      const latestMessageId = [...this.messageIds].reverse().find((messageId) => messageId !== null && messageId !== undefined);
      if (latestMessageId !== undefined) {
        await this.transport.editPlain(this.opts.chatId, latestMessageId, text).catch(() => {});
        return;
      }

      await this.transport
        .sendPlain(this.opts.chatId, text, {
          threadId: this.opts.threadId,
          replyToId: this.opts.replyToId,
        })
        .catch(() => {});
      return;
    }

    await this.deletePreviews();
  }

  private async deletePreviews(): Promise<void> {
    if (!this.transport.deleteMessage) return;

    for (const messageId of this.messageIds) {
      if (messageId === null || messageId === undefined) continue;
      await this.transport.deleteMessage(this.opts.chatId, messageId).catch(() => {});
    }
  }

  private async flushCurrentPart(forceSend = false): Promise<void> {
    this.clearTimer();
    await this.scheduleCurrentPartEdit(forceSend);
  }

  private async scheduleCurrentPartEdit(forceSend = false): Promise<void> {
    const index = this.currentIndex();
    const text = this.previewParts[index] ?? "";
    if (!text) return;

    await this.ensurePreviewMessage(index, forceSend);
    if (this.messageIds[index] === null || this.messageIds[index] === undefined) return;
    if (this.lastRenderedParts[index] === text) return;

    const elapsed = Date.now() - this.lastEditAt;
    if (forceSend || elapsed >= this.editThrottleMs()) {
      await this.editPreviewPart(index);
      return;
    }

    if (!this.editTimer) {
      const delay = this.editThrottleMs() - elapsed;
      this.editTimer = setTimeout(() => {
        this.editTimer = null;
        void this.enqueue(() => this.editPreviewPart(this.currentIndex()));
      }, delay);
    }
  }

  private async ensurePreviewMessage(index: number, forceSend = false): Promise<void> {
    if (this.messageIds[index] !== null && this.messageIds[index] !== undefined) return;

    const text = this.previewParts[index] ?? "";
    if (!text) return;
    if (!forceSend && text.length < this.minCharsBeforeSend()) return;

    this.messageIds[index] = await this.transport.sendPlain(this.opts.chatId, text, {
      threadId: this.opts.threadId,
      replyToId: index === 0 ? this.opts.replyToId : undefined,
    });
    this.lastRenderedParts[index] = text;
    this.lastEditAt = Date.now();
  }

  private async editPreviewPart(index: number): Promise<void> {
    const messageId = this.messageIds[index];
    const text = this.previewParts[index] ?? "";
    if (messageId === null || messageId === undefined || !text) return;
    if (this.lastRenderedParts[index] === text) return;

    try {
      await this.transport.editPlain(this.opts.chatId, messageId, text);
      this.lastRenderedParts[index] = text;
      this.lastEditAt = Date.now();
    } catch (err) {
      if (!isMissingMessageError(err)) throw err;
      this.messageIds[index] = null;
      this.lastRenderedParts[index] = "";
      await this.ensurePreviewMessage(index, true);
    }
  }
}
