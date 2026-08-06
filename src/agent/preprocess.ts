import { stat, rm } from "node:fs/promises";
import { dirname } from "node:path";
import type { UnifiedMessage, OutgoingMessage, Attachment } from "../channels/types.ts";
import type { ChatMessageContent } from "../llm/provider.ts";
import type { VoiceManager, SttPipeline } from "../voice/index.ts";
import type { TranscriptionResult } from "../voice/types.ts";
import { imageToBase64, extractVideoFrames } from "../media/index.ts";
import { LruMap } from "../utils/lru-map.ts";
import { log } from "../utils/logger.ts";
import { hooks } from "../hooks/index.ts";
import { normalizeUntrusted } from "./prompt/normalize-untrusted.ts";

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

export const ATTACHMENT_HEADING = "[Attachments]";

/** One `- <type>: <source> (details)` line of the block built by buildUserContent. */
export interface AttachmentBlockEntry {
  type: string;
  source: string;
  details: string[];
}

const BLOCK_LINE = /^- ([a-z]+): (.+?)(?: \((.*)\))?$/;

/**
 * Reverse of the [Attachments] block: a stored user turn keeps the LLM-facing rendering, and a
 * client that wants to show real attachments has to read it back. Only strips a trailing block
 * whose every line parses, so a user typing "[Attachments]" keeps their text intact.
 */
export function splitAttachmentBlock(content: string): { text: string; attachments: AttachmentBlockEntry[] } {
  const marker = content.lastIndexOf(`\n\n${ATTACHMENT_HEADING}\n`);
  if (marker < 0) return { text: content, attachments: [] };

  const lines = content.slice(marker + ATTACHMENT_HEADING.length + 3).split("\n").filter((line) => line.trim());
  const attachments: AttachmentBlockEntry[] = [];
  for (const line of lines) {
    const match = BLOCK_LINE.exec(line);
    if (!match) return { text: content, attachments: [] };
    attachments.push({
      type: match[1]!,
      source: match[2]!,
      details: match[3] ? match[3].split(", ") : [],
    });
  }
  if (attachments.length === 0) return { text: content, attachments: [] };
  return { text: content.slice(0, marker), attachments };
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
   * Normalised as one blob: stripping invisible characters is uniform, so there is nothing a
   * per-segment pass would decide differently. Segment-level handling only mattered while a
   * verdict could replace a segment, and that denylist is gone -- see docs/untrusted-content.md.
   */
  buildUserContent(message: UnifiedMessage): string {
    const parts: string[] = [];

    if (message.replyToText) {
      const sender = message.replyToSender ? ` from ${message.replyToSender}` : "";
      parts.push(`[Reply${sender}]\n${message.replyToText}`);
    }

    if (message.threadRootText) {
      parts.push(`[Thread Root]\n${message.threadRootText}`);
    }

    if (message.roomContext) {
      parts.push(message.roomContext);
    }

    let content = message.text;
    // Audio is listed even though its words are already in the text above. The transcript is what
    // the agent reads, but the file is what it can act on -- keep it and "save that voice note"
    // has a path to work with. It is also the only join key a replayed turn has: the my-claw-app
    // history resolves attachments out of this block, so dropping audio here made a voice note
    // come back as bare text with no bubble to play.
    const visibleAttachments = message.attachments;
    if (visibleAttachments.length > 0) {
      // Kept in sync with splitAttachmentBlock below, which reads it back out of a stored turn.
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
      content += `\n\n${ATTACHMENT_HEADING}\n${lines.join("\n")}`;
    }

    parts.push(content);
    return normalizeUntrusted(parts.filter((part) => part.trim()).join("\n\n"), "user-turn");
  }

  /**
   * Image blocks for a turn. `text` is the already-built user content, not the raw message
   * text: dropping it would strip the [Attachments] block, the reply/thread context and the
   * untrusted-content normalisation from the only turn that carries an image.
   */
  async buildImageContent(message: UnifiedMessage, text?: string): Promise<ChatMessageContent[]> {
    const paths = message.attachments.filter((a) => a.type === "image" && a.path).map((a) => a.path!);
    return imageContentFrom(text ?? message.text, paths);
  }
}

/**
 * Encoding is cached on (path, mtime, size): an image stays in the conversation for every
 * later turn, and re-reading plus resizing the same file on each one is pure waste. Small
 * cap, the values hold base64 payloads.
 */
const encodedImages = new LruMap<string, string>(8);

async function encodeImage(path: string): Promise<string | null> {
  try {
    const info = await stat(path);
    const key = `${path}:${info.mtimeMs}:${info.size}`;
    const cached = encodedImages.get(key);
    if (cached) return cached;
    const { dataUrl } = await imageToBase64(path);
    encodedImages.set(key, dataUrl);
    return dataUrl;
  } catch {
    // The file can legitimately be gone (deleted by the user, session archived): the turn
    // keeps its text, which still names the attachment.
    return null;
  }
}

/** Text plus one image block per readable path, or null when none of them can be read. */
export async function imageContentFrom(text: string, paths: string[]): Promise<ChatMessageContent[]> {
  const contents: ChatMessageContent[] = [{ type: "text", text }];
  for (const path of paths) {
    const dataUrl = await encodeImage(path);
    if (dataUrl) contents.push({ type: "image_url", image_url: { url: dataUrl } });
  }
  return contents;
}
