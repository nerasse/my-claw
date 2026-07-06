import { unlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, basename } from "node:path";

const MEDIA_PATTERN = /MEDIA:(\/[^\s]+)/g;

// Response attachments we generated ourselves are only needed until sent; without this they
// accumulate forever. TTS creates a whole temp DIRECTORY per generation (tts-XXXX/output.mp3), so
// unlinking the file alone leaves the empty dir behind — remove the dir. Browser screenshots are
// flat files (browser-*.png). Prefixes are matched under the OS temp root (not hardcoded /tmp).
function isTempRoot(dir: string): boolean {
  return dir === tmpdir() || dir === "/tmp";
}

export async function cleanupGeneratedTempFiles(attachments?: Array<{ path?: string }>): Promise<void> {
  if (!attachments?.length) return;
  for (const att of attachments) {
    const p = att.path;
    if (!p) continue;
    const parent = dirname(p);
    // Real TTS output lives in its own temp dir (tts-XXXX/output.mp3): remove the whole dir.
    if (isTempRoot(dirname(parent)) && basename(parent).startsWith("tts-")) {
      await rm(parent, { recursive: true, force: true }).catch(() => {});
      continue;
    }
    // Flat generated files directly under the temp root (browser screenshots, any flat tts file).
    if (isTempRoot(parent) && (basename(p).startsWith("browser-") || basename(p).startsWith("tts-"))) {
      await unlink(p).catch(() => {});
    }
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
