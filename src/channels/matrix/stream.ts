import type { MatrixClient } from "matrix-js-sdk";
import { buildMatrixFormattedText, prefixEditedMatrixFormattedBody } from "./format.ts";
import { withMatrixRetry } from "./retry.ts";

const MSC4357_LIVE_KEY = "org.matrix.msc4357.live";

export interface MatrixStreamOptions {
  roomId: string;
  threadId?: string;
  replyToId?: string;
  preserveReplyId?: boolean;
  sendFinal?: (text: string, replyToId?: string) => Promise<void>;
  mode?: "partial" | "quiet";
  minCharsBeforeSend?: number;
  editThrottleMs?: number;
  chunkLimit?: number;
}

function buildReplyRelation(replyToId?: string): Record<string, unknown> | undefined {
  const eventId = replyToId?.trim();
  if (!eventId) return undefined;
  return { "m.in_reply_to": { event_id: eventId } };
}

function buildThreadRelation(threadId: string, replyToId?: string): Record<string, unknown> {
  const relation: Record<string, unknown> = {
    rel_type: "m.thread",
    event_id: threadId,
    is_falling_back: true,
  };
  relation["m.in_reply_to"] = { event_id: replyToId?.trim() || threadId };
  return relation;
}

function buildRelation(threadId?: string, replyToId?: string): Record<string, unknown> | undefined {
  if (threadId?.trim()) return buildThreadRelation(threadId.trim(), replyToId);
  return buildReplyRelation(replyToId);
}

function buildReplaceRelation(originalEventId: string, threadId?: string): Record<string, unknown> {
  const relation: Record<string, unknown> = {
    rel_type: "m.replace",
    event_id: originalEventId,
  };
  if (threadId?.trim()) {
    relation["m.in_reply_to"] = { event_id: threadId.trim() };
  }
  return relation;
}

export class MatrixMessageStreamer {
  private fullText = "";
  private previewText = "";
  private sentEventId: string | null = null;
  private lastRenderedText = "";
  private lastEditAt = 0;
  private editTimer: ReturnType<typeof setTimeout> | null = null;
  private queue: Promise<void> = Promise.resolve();
  private finished = false;
  private mustFallbackToFinal = false;
  private currentReplyToId?: string;

  constructor(
    private client: MatrixClient,
    private opts: MatrixStreamOptions,
  ) {
    this.currentReplyToId = opts.replyToId;
  }

  async push(token: string): Promise<void> {
    if (!token) return;
    return this.enqueue(() => this.pushInternal(token));
  }

  async finish(finalText = this.fullText): Promise<void> {
    return this.enqueue(() => this.finishInternal(finalText));
  }

  async abort(): Promise<void> {
    return this.enqueue(async () => {
      this.finished = true;
      this.clearTimer();
      if (this.sentEventId) {
        await this.redactEvent(this.sentEventId);
      }
    });
  }

  async splitForToolUse(note = "Running tool..."): Promise<void> {
    return this.enqueue(async () => {
      if (this.finished) return;

      await this.finalizeCurrentBlock();
      this.previewText = "";
      this.fullText = "";
      this.sentEventId = null;
      this.lastRenderedText = "";
      this.lastEditAt = 0;
      this.mustFallbackToFinal = false;
      this.currentReplyToId = this.opts.preserveReplyId ? this.opts.replyToId : undefined;
    });
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => {});
    return run;
  }

  private minCharsBeforeSend(): number {
    return this.opts.minCharsBeforeSend ?? 30;
  }

  private editThrottleMs(): number {
    return this.opts.editThrottleMs ?? 1000;
  }

  private chunkLimit(): number {
    return this.opts.chunkLimit ?? 4000;
  }

  private clearTimer(): void {
    if (this.editTimer) {
      clearTimeout(this.editTimer);
      this.editTimer = null;
    }
  }

  private msgtype(): "m.text" | "m.notice" {
    return this.opts.mode === "quiet" ? "m.notice" : "m.text";
  }

  private finalMsgtype(): "m.text" {
    return "m.text";
  }

  private useLiveMarker(): boolean {
    return this.opts.mode !== "quiet";
  }

  private outboundTxnId(prefix: string): string {
    return `${prefix}-${Date.now()}-${crypto.randomUUID()}`;
  }

  private async sendMessage(content: Record<string, unknown>, prefix: string): Promise<{ event_id: string }> {
    const txnId = this.outboundTxnId(prefix);
    return await withMatrixRetry({
      task: () => this.client.sendMessage(this.opts.roomId, content as never, txnId),
    });
  }

  private async redactEvent(eventId: string): Promise<void> {
    await withMatrixRetry({
      task: async () => {
        await this.client.redactEvent(this.opts.roomId, eventId);
      },
    }).catch(() => undefined);
  }

  private previewContent(text: string): Record<string, unknown> {
    const relation = buildRelation(this.opts.threadId, this.currentReplyToId);
    const formatted = buildMatrixFormattedText(text);
    const content: Record<string, unknown> = {
      msgtype: this.msgtype(),
      body: formatted.body,
    };
    if (formatted.formatted_body) {
      content["format"] = "org.matrix.custom.html";
      content["formatted_body"] = formatted.formatted_body;
    }
    if (this.opts.mode !== "quiet" && formatted.mentions) {
      content["m.mentions"] = formatted.mentions;
    }
    if (this.useLiveMarker()) {
      content[MSC4357_LIVE_KEY] = {};
    }
    if (relation) {
      content["m.relates_to"] = relation;
    }
    return content;
  }

  private editContent(
    originalEventId: string,
    next: {
      body: string;
      formatted_body?: string;
      mentions?: Record<string, unknown>;
    },
    final = false,
  ): Record<string, unknown> {
    const msgtype = final ? this.finalMsgtype() : this.msgtype();
    const nextContent: Record<string, unknown> = {
      msgtype,
      body: next.body,
    };
    if (next.formatted_body) {
      nextContent["format"] = "org.matrix.custom.html";
      nextContent["formatted_body"] = next.formatted_body;
    }
    if (next.mentions) {
      nextContent["m.mentions"] = next.mentions;
    }
    if (!final && this.useLiveMarker()) {
      nextContent[MSC4357_LIVE_KEY] = {};
    }

    const content: Record<string, unknown> = {
      msgtype,
      body: `* ${next.body}`,
      "m.new_content": nextContent,
      "m.relates_to": buildReplaceRelation(originalEventId, this.opts.threadId),
    };
    if (next.formatted_body) {
      content["format"] = "org.matrix.custom.html";
      content["formatted_body"] = prefixEditedMatrixFormattedBody(next.formatted_body);
    }
    if (next.mentions) {
      content["m.mentions"] = next.mentions;
    }
    if (!final && this.useLiveMarker()) {
      content[MSC4357_LIVE_KEY] = {};
    }
    return content;
  }

  private async pushInternal(token: string): Promise<void> {
    if (this.finished) return;

    this.fullText += token;
    this.previewText += token;

    if (this.previewText.length > this.chunkLimit()) {
      this.mustFallbackToFinal = true;
      return;
    }

    await this.flushPreview(false);
  }

  private async finishInternal(finalText: string): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    this.fullText = finalText;
    this.clearTimer();

    const text = finalText.trimEnd();
    if (!text) {
      if (this.sentEventId) {
        await this.redactEvent(this.sentEventId);
      }
      return;
    }

    if (this.sentEventId && !this.mustFallbackToFinal) {
      const formatted = buildMatrixFormattedText(text);
      try {
        await this.sendMessage(
          this.editContent(
            this.sentEventId,
            {
              body: formatted.body,
              formatted_body: formatted.formatted_body,
              mentions: formatted.mentions as Record<string, unknown> | undefined,
            },
            true,
          ),
          "stream-final-edit",
        );
        return;
      } catch {
        await this.redactEvent(this.sentEventId);
        this.sentEventId = null;
      }
    }

    if (this.sentEventId && this.mustFallbackToFinal) {
      await this.redactEvent(this.sentEventId);
      this.sentEventId = null;
    }

    await this.deliverFinalNormally(text);
  }

  private async finalizeCurrentBlock(): Promise<void> {
    this.clearTimer();
    const text = this.previewText.trimEnd();
    if (!text) {
      if (this.sentEventId) {
        await this.redactEvent(this.sentEventId);
      }
      return;
    }

    if (this.sentEventId && !this.mustFallbackToFinal) {
      const formatted = buildMatrixFormattedText(text);
      try {
        await this.sendMessage(
          this.editContent(
            this.sentEventId,
            {
              body: formatted.body,
              formatted_body: formatted.formatted_body,
              mentions: formatted.mentions as Record<string, unknown> | undefined,
            },
            true,
          ),
          "stream-block-finalize",
        );
        return;
      } catch {
        await this.redactEvent(this.sentEventId);
        this.sentEventId = null;
      }
    }

    if (this.sentEventId && this.mustFallbackToFinal) {
      await this.redactEvent(this.sentEventId);
      this.sentEventId = null;
    }

    await this.deliverFinalNormally(text);
  }

  private async deliverFinalNormally(text: string): Promise<void> {
    if (this.opts.sendFinal) {
      await this.opts.sendFinal(text, this.currentReplyToId);
      return;
    }

    const formatted = buildMatrixFormattedText(text);
    const relation = buildRelation(this.opts.threadId, this.currentReplyToId);
    const finalContent: Record<string, unknown> = {
      msgtype: this.finalMsgtype(),
      body: formatted.body,
    };
    if (formatted.formatted_body) {
      finalContent["format"] = "org.matrix.custom.html";
      finalContent["formatted_body"] = formatted.formatted_body;
    }
    if (formatted.mentions) {
      finalContent["m.mentions"] = formatted.mentions;
    }
    if (relation) {
      finalContent["m.relates_to"] = relation;
    }
    await this.sendMessage(finalContent, "stream-final-send");
  }

  private async flushPreview(forceSend: boolean): Promise<void> {
    if (!this.previewText || this.mustFallbackToFinal) return;

    if (!this.sentEventId) {
      if (!forceSend && this.previewText.length < this.minCharsBeforeSend()) {
        return;
      }
      const result = await this.sendMessage(
        this.previewContent(this.previewText),
        "stream-preview-create",
      ).catch(async () => {
        this.mustFallbackToFinal = true;
        if (this.sentEventId) {
          await this.redactEvent(this.sentEventId);
          this.sentEventId = null;
        }
        this.lastRenderedText = "";
        this.clearTimer();
        return undefined;
      });
      if (!result) return;
      this.sentEventId = result.event_id;
      this.lastRenderedText = this.previewText;
      this.lastEditAt = Date.now();
      return;
    }

    if (this.lastRenderedText === this.previewText) return;
    const elapsed = Date.now() - this.lastEditAt;
    if (!forceSend && elapsed < this.editThrottleMs()) {
      if (!this.editTimer) {
        const delay = this.editThrottleMs() - elapsed;
        this.editTimer = setTimeout(() => {
          this.editTimer = null;
          void this.enqueue(() => this.flushPreview(true));
        }, delay);
      }
      return;
    }

    const formatted = buildMatrixFormattedText(this.previewText);
    await this.sendMessage(
      this.editContent(this.sentEventId, {
        body: formatted.body,
        formatted_body: formatted.formatted_body,
        mentions: this.opts.mode === "quiet" ? undefined : (formatted.mentions as Record<string, unknown> | undefined),
      }),
      "stream-preview-edit",
    ).catch(async () => {
      this.mustFallbackToFinal = true;
      if (this.sentEventId) {
        await this.redactEvent(this.sentEventId);
        this.sentEventId = null;
      }
      this.lastRenderedText = "";
      this.clearTimer();
    });
    if (this.mustFallbackToFinal) return;
    this.lastRenderedText = this.previewText;
    this.lastEditAt = Date.now();
  }
}
