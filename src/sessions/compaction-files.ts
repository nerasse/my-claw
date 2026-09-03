/**
 * The files a branch touched, derived from the log rather than from the summary -- docs/compaction.md.
 *
 * Everything else in a compaction is the model's paraphrase of what happened, and a paraphrase of a
 * paraphrase loses paths first: they are the longest, least prose-like thing in the transcript. pi
 * and oh-my-pi both answer this by extracting the paths in code and re-attaching them verbatim
 * underneath the generated text, and both then have to *accumulate* them from one compaction entry
 * to the next, because their discarded history is no longer readable.
 *
 * Here the log is never deleted, so there is nothing to accumulate: the list is recomputed from the
 * whole branch every time. A path cannot drift, be dropped or be duplicated by a chain of
 * compactions, because no compaction is ever its source.
 */

import type { Entry, ToolEntry } from "./log.ts";

/** Tools whose `path` argument names a file the model read. */
const READERS = new Set(["read"]);
/** Tools whose `path` argument names a file the model changed. */
const WRITERS = new Set(["write", "apply_patch"]);

const MAX_PATHS_PER_LIST = 40;
const MAX_PATH_CHARS = 256;

/**
 * A path, made safe to sit inside the block.
 *
 * The value comes from a model's tool arguments, so it is untrusted text that happens to have been
 * a path when the call succeeded. A newline in it would let anything after it pose as a line of the
 * anchor -- or as the end of it -- in a summary that becomes permanent prompt.
 */
function cleanPath(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const flat = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (!flat) return undefined;
  return flat.length > MAX_PATH_CHARS ? `${flat.slice(0, MAX_PATH_CHARS)}...` : flat;
}

function renderList(tag: string, paths: string[]): string[] {
  if (paths.length === 0) return [];
  const shown = paths.slice(0, MAX_PATHS_PER_LIST);
  const elided = paths.length - shown.length;
  return [
    `<${tag}>`,
    ...shown,
    ...(elided > 0 ? [`[${elided} more]`] : []),
    `</${tag}>`,
  ];
}

/**
 * The anchor block for a branch, or an empty string when it touched no file.
 *
 * Most recent first: a list that has to be cut keeps what the next turn is likely to want. A file
 * that was both read and written is reported as written only -- the stronger statement, and the one
 * that matters when deciding whether the work is still ahead.
 */
export function fileAnchorOf(entries: readonly Entry[]): string {
  const read: string[] = [];
  const modified: string[] = [];
  const seen = new Set<string>();

  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    if (entry.type !== "tool") continue;
    const tool = entry as ToolEntry;
    if (!tool.ok) continue;
    const isReader = READERS.has(tool.name);
    const isWriter = WRITERS.has(tool.name);
    if (!isReader && !isWriter) continue;
    const path = cleanPath(tool.args["path"]);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    (isWriter ? modified : read).push(path);
  }

  const lines = [...renderList("modified-files", modified), ...renderList("read-files", read)];
  return lines.length > 0 ? lines.join("\n") : "";
}
