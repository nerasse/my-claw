/**
 * Minimal unified diff builder for the apply_patch tool.
 *
 * Produces a classic `--- a/...` / `+++ b/...` / `@@ -a,b +c,d @@` hunks with `-`/`+` prefixed
 * lines, one hunk per contiguous change (with up to 3 context lines around it). The app renders
 * this output in red/green, so the format matters more than the algorithm: it must stay readable
 * in a card and cheap to parse.
 *
 * The diff is cosmetic, not canonical: the file on disk is the source of truth, and this is only
 * what the model and the owner see after a successful patch.
 */

type LineKind = "context" | "add" | "del";
interface DiffLine {
  kind: LineKind;
  text: string;
}

const CONTEXT = 3;

/** Splits text into lines, dropping a single trailing newline artifact. */
function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Line-level diff using the longest common prefix/suffix slide:
 * - context: identical lines around the change
 * - del: old lines removed
 * - add: new lines added
 */
function lineDiff(oldLines: string[], newLines: string[]): DiffLine[] {
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const out: DiffLine[] = [];
  for (let i = 0; i < prefix; i++) out.push({ kind: "context", text: oldLines[i]! });
  const oldMid = oldLines.slice(prefix, oldLines.length - suffix);
  const newMid = newLines.slice(prefix, newLines.length - suffix);
  // LCS on the changed block so untouched lines inside it stay context instead of being shown as
  // a wholesale removal/addition (the prefix/suffix slide cannot see them).
  const alignment = lcs(oldMid, newMid);
  for (const step of alignment) {
    out.push({ kind: step.kind, text: step.text });
  }
  for (let i = oldLines.length - suffix; i < oldLines.length; i++) out.push({ kind: "context", text: oldLines[i]! });
  return out;
}

/**
 * Diff of two blocks with a dynamic-programming LCS, emitting context/del/add steps in order.
 * Falls back to a plain slide (all del then all add) when the blocks are too large to justify
 * the O(n*m) table: patch edits are anchored on small regions, not whole files.
 */
function lcs(a: string[], b: string[]): DiffLine[] {
  const n = a.length;
  const m = b.length;
  if (n * m > 200_000) {
    const out: DiffLine[] = [];
    for (const line of a) out.push({ kind: "del", text: line });
    for (const line of b) out.push({ kind: "add", text: line });
    return out;
  }
  // dp[i][j] = length of LCS of a[i..] and b[j..]
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    const ai = a[i]!;
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = ai === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: "context", text: a[i]! });
      i += 1;
      j += 1;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ kind: "del", text: a[i]! });
      i += 1;
    } else {
      out.push({ kind: "add", text: b[j]! });
      j += 1;
    }
  }
  while (i < n) {
    out.push({ kind: "del", text: a[i]! });
    i += 1;
  }
  while (j < m) {
    out.push({ kind: "add", text: b[j]! });
    j += 1;
  }
  return out;
}

/**
 * Builds a unified diff between two file contents.
 * Returns an empty string when the contents are identical.
 */
export function buildUnifiedDiff(path: string, oldText: string, newText: string): string {
  if (oldText === newText) return "";
  const lines = lineDiff(splitLines(oldText), splitLines(newText));

  // Hunks are windows around changes: for each changed line, take CONTEXT lines of context on each
  // side, then merge overlapping/adjacent windows. Context runs with no change nearby stay out.
  const changeAt = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.kind !== "context") changeAt.add(i);
  }
  const windows: Array<[number, number]> = [];
  for (const idx of changeAt) {
    const start = Math.max(0, idx - CONTEXT);
    const end = Math.min(lines.length - 1, idx + CONTEXT);
    const last = windows[windows.length - 1];
    if (last !== undefined && start <= last[1] + 1) {
      last[1] = Math.max(last[1], end);
    } else {
      windows.push([start, end]);
    }
  }
  const hunks: DiffLine[][] = windows.map(([start, end]) => lines.slice(start, end + 1));

  // Compute absolute positions for each hunk by walking the diff once.
  const out: string[] = [`--- ${path}`, `+++ ${path}`];
  let oldLine = 1;
  let newLine = 1;
  let i = 0;
  for (const hunk of hunks) {
    // Advance counters to the first line of this hunk (lines[i] may be undefined only past the end).
    while (lines[i] !== hunk[0]) {
      const line = lines[i]!;
      if (line.kind === "add") newLine += 1;
      else if (line.kind === "del") oldLine += 1;
      else {
        oldLine += 1;
        newLine += 1;
      }
      i += 1;
    }
    const oldStart = oldLine;
    const newStart = newLine;
    const oldCount = hunk.filter(l => l.kind !== "add").length;
    const newCount = hunk.filter(l => l.kind !== "del").length;
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const line of hunk) {
      out.push(`${line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}${line.text}`);
      if (line.kind === "add") newLine += 1;
      else if (line.kind === "del") oldLine += 1;
      else {
        newLine += 1;
        oldLine += 1;
      }
    }
    i += hunk.length;
  }
  return out.join("\n");
}
