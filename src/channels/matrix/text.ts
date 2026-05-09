export type MatrixChunkMode = "plain" | "line";

export function chunkMatrixText(text: string, limit: number, mode: MatrixChunkMode): string[] {
  const trimmed = text.trimEnd();
  if (!trimmed) return [];
  if (trimmed.length <= limit) return [trimmed];

  const chunks: string[] = [];
  let remaining = trimmed;
  while (remaining.length > limit) {
    let splitAt = limit;
    if (mode === "line") {
      const newline = remaining.lastIndexOf("\n", limit);
      if (newline > Math.floor(limit * 0.4)) {
        splitAt = newline;
      } else {
        const space = remaining.lastIndexOf(" ", limit);
        if (space > Math.floor(limit * 0.4)) splitAt = space;
      }
    }
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks.filter(Boolean);
}
