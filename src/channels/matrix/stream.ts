import type { MatrixClient } from "matrix-js-sdk";
import { buildMatrixFormattedText, prefixEditedMatrixFormattedBody } from "./format.ts";
import { buildRelation, buildReplaceRelation } from "./helpers.ts";
import { withMatrixRetry } from "./retry.ts";
import { toSdkContent } from "./send.ts";
import { stripMediaRefs } from "../../utils/media.ts";
import { formatToolStatusVerbose, formatToolStatusCompact, type ToolCallResult } from "../../agent/tool-status.ts";
import { matrixLog } from "../../utils/logger.ts";

const MSC4357_LIVE_KEY = "org.matrix.msc4357.live";
const DEFAULT_CHUNK_LIMIT = 4000;

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
  retry?: {
    attempts?: number;
    minDelayMs?: number;
    maxDelayMs?: number;
  };
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

  async abort(errorText?: string): Promise<void> {
    return this.enqueue(async () => {
      // After a successful finish there is nothing to annotate — the final message was delivered
      // and must not be touched (the previous code redacted it, deleting a delivered response).
      if (this.finished) return;
      this.finished = true;
      this.clearTimer();
      // Never redact and never send a standalone error here. Streamed preview text is content
      // the user already saw — deleting it on failure turns an error into data loss (observed
      // as "message deleted" in clients when a shutdown raced an active stream). The adapter's
      // error reporter owns user-facing error delivery; this only annotates the preview in place.
      if (!this.sentEventId) return;
      const err = errorText?.trim();
      const partial = this.previewText.trimEnd();
      const text = partial ? `${partial}\n\n[interrupted${err ? `: ${err}` : ""}]` : err;
      if (!text) return;
      const formatted = buildMatrixFormattedText(text);
      await this.sendMessage(
        this.editContent(this.sentEventId, {
          body: formatted.body,
          formatted_body: formatted.formatted_body,
          mentions: formatted.mentions as Record<string, unknown> | undefined,
        }, true),
        "stream-abort-edit",
      ).catch((e) => {
        // Edit can fail when the client is already tearing down; the raw preview beats nothing.
        matrixLog("debug", "abort edit failed, leaving preview as-is", { error: String(e) }).catch(() => {});
      });
    });
  }

  async appendToolUse(toolCalls: ToolCallResult[], verbose: boolean): Promise<void> {
    const note = verbose ? formatToolStatusVerbose(toolCalls) : formatToolStatusCompact(toolCalls);
    if (!note) return;
    return this.enqueue(() => this.pushInternal(note));
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
    return this.opts.chunkLimit ?? DEFAULT_CHUNK_LIMIT;
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
      task: () => this.client.sendMessage(this.opts.roomId, toSdkContent(content), txnId),
      ...(this.opts.retry || {}),
    });
  }

  private async redactEvent(eventId: string): Promise<void> {
    await withMatrixRetry({
      task: async () => {
        await this.client.redactEvent(this.opts.roomId, eventId);
      },
      ...(this.opts.retry || {}),
    }).catch((e) => { matrixLog("debug", "redact stream event failed", { error: String(e) }).catch(() => {}); });
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
    const cleanText = stripMediaRefs(finalText);
    this.fullText = cleanText;
    this.clearTimer();

    const text = cleanText.trimEnd();
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
        // fall through to a fresh send; the preview is only redacted once that send succeeded
      }
    }

    // Redact the stale preview only AFTER the replacement is delivered: redact-first would
    // destroy the streamed content if the final send then fails (crash, network, shutdown).
    const stalePreviewId = this.sentEventId;
    try {
      await this.deliverFinalNormally(text);
    } catch (err) {
      // The preview id is kept until here on purpose: dropping it first left a half-written
      // message flagged live in the room, with nothing able to close it ever again.
      if (stalePreviewId) await this.closeLivePreview(stalePreviewId, text);
      throw err;
    }
    this.sentEventId = null;
    if (stalePreviewId) {
      await this.redactEvent(stalePreviewId);
    }
  }

  /** Rewrites the preview without the live marker, so a failed final does not leave it typing. */
  private async closeLivePreview(eventId: string, text: string): Promise<void> {
    const formatted = buildMatrixFormattedText(`${text.trimEnd()}\n\n[interrupted]`);
    await this.sendMessage(
      this.editContent(eventId, {
        body: formatted.body,
        formatted_body: formatted.formatted_body,
        mentions: formatted.mentions as Record<string, unknown> | undefined,
      }, true),
      "stream-final-close",
    ).catch(() => undefined);
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
    // A throttled preview edit queued before finish must not run after it: it would overwrite the
    // final formatted message with stale preview text and re-add the live marker.
    if (this.finished) return;
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
