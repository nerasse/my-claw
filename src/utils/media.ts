const MEDIA_PATTERN = /MEDIA:(\/[^\s]+)/g;

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
