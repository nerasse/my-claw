import { unlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, basename, resolve, sep } from "node:path";
import { attachmentRoot } from "../tools/workspace.ts";

const MEDIA_PATTERN = /MEDIA:(\/[^\s]+)/g;

// Response attachments we generated ourselves are only needed until sent; without this they
// accumulate forever. TTS creates a whole temp DIRECTORY per generation (tts-XXXX/output.mp3), so
// unlinking the file alone leaves the empty dir behind — remove the dir. `/instructions` does the
// same with prompt-XXXX/prompt-<agent>.md. Browser screenshots are flat files (browser-*.png).
// Prefixes are matched under the OS temp root (not hardcoded /tmp).
function isTempRoot(dir: string): boolean {
  return dir === tmpdir() || dir === "/tmp";
}

export async function cleanupGeneratedTempFiles(attachments?: Array<{ path?: string }>): Promise<void> {
  if (!attachments?.length) return;
  for (const att of attachments) {
    const p = att.path;
    if (!p) continue;
    const parent = dirname(p);
    // Output that lives in its own temp dir (tts-XXXX/output.mp3, prompt-XXXX/prompt-main.md):
    // remove the whole dir.
    if (isTempRoot(dirname(parent)) && (basename(parent).startsWith("tts-") || basename(parent).startsWith("prompt-"))) {
      await rm(parent, { recursive: true, force: true }).catch(() => {});
      continue;
    }
    // Flat generated files directly under the temp root (browser screenshots, any flat tts file).
    if (isTempRoot(parent) && (basename(p).startsWith("browser-") || basename(p).startsWith("tts-"))) {
      await unlink(p).catch(() => {});
    }
  }
}

/**
 * Deletes the per-run temporaries a channel downloaded (dropped in the
 * temp root). Files under the attachment root are the my-claw-app channel's persistent per-session
 * store: they outlive the run by design (docs/my-claw-app-channel.md), back files.list and
 * GET /media, and are re-read on later turns to keep an image in the conversation.
 */
export async function cleanupAttachments(attachments: Array<{ path?: string }>): Promise<void> {
  const persistentRoot = resolve(attachmentRoot());
  for (const att of attachments) {
    if (!att.path) continue;
    const full = resolve(att.path);
    if (full === persistentRoot || full.startsWith(persistentRoot + sep)) continue;
    await unlink(full).catch(() => {});
  }
}

export interface MediaRef {
  path: string;
  match: string;
  audioAsVoice?: boolean;
  durationMs?: number;
}

/** The only format table for MEDIA: refs: everything not listed falls back to "file". */
const MEDIA_TYPE_BY_EXT: Record<string, "image" | "video" | "audio"> = {
  jpg: "image", jpeg: "image", png: "image", webp: "image", gif: "image", heic: "image", svg: "image",
  mp4: "video", mov: "video", webm: "video", mkv: "video", avi: "video",
  mp3: "audio", m4a: "audio", wav: "audio", ogg: "audio", oga: "audio", opus: "audio", aac: "audio", flac: "audio", amr: "audio", weba: "audio",
};

export function mediaTypeForPath(path: string): "image" | "audio" | "video" | "file" {
  const dot = path.lastIndexOf(".");
  if (dot <= 0) return "file";
  return MEDIA_TYPE_BY_EXT[path.slice(dot + 1).toLowerCase()] ?? "file";
}

/**
 * The ranges of `text` markdown renders as code: fenced blocks and inline spans.
 *
 * A `MEDIA:` ref inside one is the agent talking *about* the format -- the system prompt teaches it,
 * so every message that explains it quotes it -- and never a file it means to send. Read as an
 * intent, each quoted example became an attachment whose file does not exist: drawn as an empty
 * thumbnail when it looked like an image, as "<name> (deleted)" otherwise, with the example cut out
 * of the sentence around it (2026-09-14).
 */
function codeRanges(text: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  const fenceAt = /^ {0,3}(`{3,}|~{3,})/;
  let openFrom = -1;
  let marker = "";
  let offset = 0;
  for (const line of text.split("\n")) {
    const fence = fenceAt.exec(line)?.[1];
    if (openFrom < 0 && fence) {
      openFrom = offset;
      marker = fence;
    } else if (openFrom >= 0 && fence && fence[0] === marker[0] && fence.length >= marker.length) {
      ranges.push({ start: openFrom, end: offset + line.length });
      openFrom = -1;
    } else if (openFrom < 0) {
      // Line by line: an unmatched run is prose, not an opening quote. Treating it as one would
      // hide the rest of the message behind it, and lose a real file with it.
      for (let i = 0; i < line.length; ) {
        if (line[i] !== "`") {
          i += 1;
          continue;
        }
        const run = /^`+/.exec(line.slice(i))![0].length;
        const close = line.indexOf("`".repeat(run), i + run);
        if (close < 0) break;
        ranges.push({ start: offset + i, end: offset + close + run });
        i = close + run;
      }
    }
    offset += line.length + 1;
  }
  if (openFrom >= 0) ranges.push({ start: openFrom, end: text.length });
  return ranges;
}

/** Every `MEDIA:` ref of the prose, with the bounds of the text it occupies. */
function proseRefs(text: string): Array<{ path: string; from: number; to: number }> {
  const code = codeRanges(text);
  const refs: Array<{ path: string; from: number; to: number }> = [];
  MEDIA_PATTERN.lastIndex = 0;
  let match;
  while ((match = MEDIA_PATTERN.exec(text)) !== null) {
    const from = match.index;
    if (code.some((range) => from >= range.start && from < range.end)) continue;
    refs.push({ path: match[1]!, from, to: from + match[0]!.length });
  }
  return refs;
}

/** The text with the prose refs taken out; a ref inside code is prose and stays where it is. */
function removeProseRefs(text: string): string {
  let out = "";
  let at = 0;
  for (const ref of proseRefs(text)) {
    out += text.slice(at, ref.from);
    at = ref.to;
  }
  return out + text.slice(at);
}

export function extractMediaRefs(text: string): MediaRef[] {
  return proseRefs(text).map((ref) => ({ path: ref.path, match: text.slice(ref.from, ref.to) }));
}

export function stripMediaRefs(text: string): string {
  return removeProseRefs(text).trim();
}

/**
 * A ref whose tail has not fully arrived is indistinguishable from text that only starts like
 * one. Withheld until the next token decides, so a ref split across stream tokens never
 * flashes on screen and never gets sent half-finished.
 */
const PARTIAL_REF_TAIL = /(?<![A-Za-z0-9_])(?:MED|MEDI|MEDIA|MEDIA:|MEDIA:\/)$/;

/**
 * Like stripMediaRefs, for text still being streamed: completed refs are removed, and a
 * trailing fragment that could still grow into one is held back instead of emitted. The
 * fragment is released whole as soon as the following token proves it was not a ref.
 */
export function stripMediaRefsStreaming(raw: string): string {
  const stripped = removeProseRefs(raw);
  const tail = PARTIAL_REF_TAIL.exec(stripped)?.[0] ?? "";
  return stripped.slice(0, stripped.length - tail.length);
}
