import { stat, rm } from "node:fs/promises";
import { dirname } from "node:path";
import type { UnifiedMessage, OutgoingMessage, Attachment } from "../channels/types.ts";
import type { ChatMessageContent } from "../llm/provider.ts";
import type { VoiceManager, SttPipeline } from "../voice/index.ts";
import type { TranscriptionResult } from "../voice/types.ts";
import { imageToBase64, extractVideoFrames } from "../media/index.ts";
import { log } from "../utils/logger.ts";
import { hooks } from "../hooks/index.ts";
import { scanSegment, type ScanSanction } from "./prompt/anti-injection.ts";
import type { ScanPolicy } from "../core/config.ts";

/** Per-run scratch state, keyed by message id. A single MessagePreprocessor instance is shared
 *  by the one AgentBridge that serves telegram + matrix + cron, so concurrent runs (different
 *  sessions/platforms) MUST NOT share these buffers — otherwise run B wipes or steals run A's
 *  response attachments/echoes/temp dirs, and a voice note can be delivered to the wrong chat.
 *  Keying by the (unique) message id isolates each run. */
interface PreprocessRunState {
  echoMessages: OutgoingMessage[];
  responseAttachments: NonNullable<OutgoingMessage["attachments"]>;
  tempDirs: string[];
  hadAudio: boolean;
}

export class MessagePreprocessor {
  private processed = new Set<string>();
  private runs = new Map<string, PreprocessRunState>();

  constructor(
    private voiceManager?: VoiceManager,
    private sttPipeline?: SttPipeline,
  ) {}

  private stateFor(messageId: string): PreprocessRunState {
    let state = this.runs.get(messageId);
    if (!state) {
      state = { echoMessages: [], responseAttachments: [], tempDirs: [], hadAudio: false };
      this.runs.set(messageId, state);
    }
    return state;
  }

  inboundHadAudio(messageId: string): boolean {
    return this.runs.get(messageId)?.hadAudio ?? false;
  }

  consumeEchoMessages(messageId: string): OutgoingMessage[] {
    const state = this.runs.get(messageId);
    if (!state) return [];
    const echoes = [...state.echoMessages];
    state.echoMessages = [];
    return echoes;
  }

  consumeResponseAttachments(messageId: string): OutgoingMessage["attachments"] {
    const state = this.runs.get(messageId);
    if (!state) return [];
    const attachments = [...state.responseAttachments];
    state.responseAttachments = [];
    return attachments;
  }

  addResponseAttachment(messageId: string, att: Attachment): void {
    this.stateFor(messageId).responseAttachments.push(att);
  }

  async preprocessMessage(message: UnifiedMessage): Promise<void> {
    if (this.processed.has(message.id)) return;
    this.processed.add(message.id);
    await this.preprocessAudio(message);
    await this.preprocessVideo(message);
    hooks.emit("message:preprocessed", { message, transcription: message.text });
  }

  async preprocessForHandle(message: UnifiedMessage): Promise<void> {
    if (this.processed.has(message.id)) return;
    this.processed.add(message.id);
    await this.preprocessAudio(message);
    await this.preprocessVideo(message);
  }

  /** Runs in the bridge's finally: drop this run's temp dirs and forget its scratch state.
   *  Response attachments are consumed by the router AFTER handle() returns, so they are NOT
   *  cleared here — the router's consumeResponseAttachments removes the bucket. */
  async cleanupTempFiles(messageId: string): Promise<void> {
    const state = this.runs.get(messageId);
    this.processed.delete(messageId);
    if (!state) return;
    for (const dir of state.tempDirs) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
    state.tempDirs = [];
    // Keep the bucket only if response attachments are still pending pickup by the router.
    if (state.responseAttachments.length === 0 && state.echoMessages.length === 0) {
      this.runs.delete(messageId);
    }
  }

  private async preprocessAudio(message: UnifiedMessage): Promise<TranscriptionResult> {
    const state = this.stateFor(message.id);
    const audioAttachments = message.attachments.filter((a) => a.type === "audio");
    if (audioAttachments.length === 0) {
      return { text: "" };
    }

    if (!this.voiceManager || !this.sttPipeline) {
      const existingText = message.text ? message.text.trim() : "";
      const prefix = existingText ? `\n\n` : "";
      message.text = `${existingText}${prefix}[Audio]: [voice/STT not configured]`;
      return { text: "", error: "voice/STT not configured" };
    }

    state.hadAudio = true;
    const multi = audioAttachments.length > 1;
    const transcriptions: string[] = [];
    let lastError: string | undefined;

    for (let i = 0; i < audioAttachments.length; i++) {
      const att = audioAttachments[i]!;
      const label = multi ? `[Audio ${i + 1}]` : "[Audio]";

      if (!att.path) {
        const isEncrypted = att.summaryText?.includes("unavailable") ?? false;
        const reason = isEncrypted
          ? "This media is encrypted (E2EE) and inaccessible. Check my device in the room or send an unencrypted message."
          : "Media not downloaded (unavailable or too large).";

        const existingText = message.text ? message.text.trim() : "";
        const audioPrefix = existingText ? `\n\n` : "";
        message.text = `${existingText}${audioPrefix}${label}: [unavailable — ${reason}]`;

        const { enabled } = this.voiceManager.getEchoConfig();
        if (enabled) {
          state.echoMessages.push({
            text: `[Warning] ${reason}`,
            replyToId: message.id,
            threadId: message.threadId,
          });
        }

        lastError = reason;
        continue;
      }

      try {
        const fileStat = await stat(att.path);
        void log("info", "STT processing audio", { path: att.path, size: fileStat.size, mimeType: att.mimeType });

        // Configured language applies to the owner's voice notes only. Any other audio file
        // could be in any language, and a forced mismatch makes Whisper produce confident
        // nonsense rather than an error.
        const language = att.audioAsVoice ? this.sttPipeline.voiceNoteLanguage() : undefined;
        const result = await this.sttPipeline.transcribe(att.path, language);
        transcriptions.push(result.text);
        const existingText = message.text ? message.text.trim() : "";
        const audioPrefix = existingText ? `\n\n` : "";
        message.text = `${existingText}${audioPrefix}${label}: "${result.text}"`;

        const { enabled } = this.voiceManager.getEchoConfig();
        if (enabled) {
          state.echoMessages.push({
            text: this.voiceManager.formatEcho(result.text),
            replyToId: message.id,
            threadId: message.threadId,
          });
        }
      } catch (err) {
        const errorMsg = String(err);
        lastError = errorMsg;
        const existingText = message.text ? message.text.trim() : "";
        const audioPrefix = existingText ? `\n\n` : "";
        message.text = `${existingText}${audioPrefix}${label}: [Transcription failed: ${errorMsg}]`;

        const { enabled } = this.voiceManager.getEchoConfig();
        if (enabled) {
          state.echoMessages.push({
            text: `[Warning] STT failed: ${errorMsg}`,
            replyToId: message.id,
            threadId: message.threadId,
          });
        }
      }
    }

    const combinedText = transcriptions.join(" ");
    if (combinedText) {
      return { text: combinedText };
    }
    return { text: "", error: lastError };
  }

  private async preprocessVideo(message: UnifiedMessage): Promise<void> {
    const state = this.stateFor(message.id);
    const videoAttachments = message.attachments.filter((a) => a.type === "video" && a.path);
    if (videoAttachments.length === 0) return;

    for (const att of videoAttachments) {
      if (!att.path) continue;
      try {
        const frames = await extractVideoFrames(att.path, {
          fps: 1 / 3,
          maxFrames: 20,
          maxWidth: 1920,
        });

        if (frames.length > 0) {
          state.tempDirs.push(dirname(frames[0]!));
        }

        for (const framePath of frames) {
          message.attachments.push({
            type: "image",
            path: framePath,
            mimeType: "image/jpeg",
          });
        }

        const existingText = message.text ? message.text.trim() : "";
        const prefix = existingText ? `\n\n` : "";
        message.text = `${existingText}${prefix}[Video]: "${att.filename ?? "video"}" (${frames.length} frames extracted)`;
      } catch (err) {
        const errorMsg = String(err);
        const existingText = message.text ? message.text.trim() : "";
        const prefix = existingText ? `\n\n` : "";
        message.text = `${existingText}${prefix}[Video]: [Frame extraction failed: ${errorMsg}]`;
      }
    }

    message.attachments = message.attachments.filter((a) => a.type !== "video");
  }

  /**
   * Each segment is scanned on its own so a verdict on quoted or contextual text cannot destroy
   * the sender's actual question -- the single-blob scan this replaces let one stray zero-width
   * space anywhere blank the whole turn. Segment headers stay outside the scanned text so a
   * blocked segment keeps its shape instead of collapsing into the marker.
   * See docs/anti-injection.md.
   */
  buildUserContent(message: UnifiedMessage, scan: ScanPolicy): string {
    const scanned = (text: string, label: string, sanction: ScanSanction): string =>
      scanSegment(text, label, scan.enabled ? sanction : "off").content;
    const parts: string[] = [];

    if (message.replyToText) {
      const sender = message.replyToSender ? ` from ${message.replyToSender}` : "";
      parts.push(`[Reply${sender}]\n${scanned(message.replyToText, "reply", "block")}`);
    }

    if (message.threadRootText) {
      parts.push(`[Thread Root]\n${scanned(message.threadRootText, "thread-root", "block")}`);
    }

    if (message.roomContext) {
      parts.push(scanned(message.roomContext, "room-context", "block"));
    }

    let content = scanned(message.text, "user-text", scan.ownerSanction);
    const visibleAttachments = message.attachments.filter((a) => a.type !== "audio");
    if (visibleAttachments.length > 0) {
      const lines = visibleAttachments.map((a) => {
        const source = a.path ?? a.url ?? "unknown";
        const details = [
          a.mimeType,
          typeof a.sizeBytes === "number" ? `${a.sizeBytes} bytes` : undefined,
          a.filename,
          typeof a.width === "number" && typeof a.height === "number" ? `${a.width}x${a.height}` : undefined,
          typeof a.durationMs === "number" ? `${a.durationMs} ms` : undefined,
        ].filter(Boolean);
        return `- ${a.type}: ${source}${details.length > 0 ? ` (${details.join(", ")})` : ""}`;
      });
      // Paths and filenames come from the sender, not from my-claw.
      content += `\n\n[Attachments]\n${scanned(lines.join("\n"), "attachments", "block")}`;
    }

    parts.push(content);
    return parts.filter((part) => part.trim()).join("\n\n");
  }

  async buildImageContent(message: UnifiedMessage): Promise<ChatMessageContent[]> {
    const contents: ChatMessageContent[] = [{ type: "text", text: message.text }];

    for (const att of message.attachments) {
      if (att.type === "image" && att.path) {
        const { dataUrl } = await imageToBase64(att.path);
        contents.push({ type: "image_url", image_url: { url: dataUrl } });
      }
    }

    return contents;
  }
}
