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
 * Deletes the per-run temporaries a channel downloaded (Telegram and Matrix drop theirs in the
 * temp root). Files under the attachment root are the mobile channel's persistent per-session
 * store: they outlive the run by design (docs/mobile-channel.md), back files.list and
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

export function extractMediaRefs(text: string): MediaRef[] {
  const refs: MediaRef[] = [];
  let match;
  while ((match = MEDIA_PATTERN.exec(text)) !== null) {
    refs.push({ path: match[1]!, match: match[0]! });
  }
  return refs;
}

export function stripMediaRefs(text: string): string {
  return text.replace(MEDIA_PATTERN, "").trim();
}
