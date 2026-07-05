import { unlink } from "node:fs/promises";

const MEDIA_PATTERN = /MEDIA:(\/[^\s]+)/g;

// Response attachments we generated ourselves (TTS audio, browser screenshots) live in
// /tmp and are only needed until they are sent; without this they accumulate forever.
const GENERATED_TMP_PREFIXES = ["/tmp/tts-", "/tmp/browser-"];

export async function cleanupGeneratedTempFiles(attachments?: Array<{ path?: string }>): Promise<void> {
  if (!attachments?.length) return;
  for (const att of attachments) {
    const p = att.path;
    if (p && GENERATED_TMP_PREFIXES.some((prefix) => p.startsWith(prefix))) {
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

export function deduplicateMediaRefs(
  refs: MediaRef[],
  attachments: Array<{ path?: string }>,
): MediaRef[] {
  const attachedPaths = new Set(attachments.map((a) => a.path).filter(Boolean));
  return refs.filter((ref) => !attachedPaths.has(ref.path));
}
