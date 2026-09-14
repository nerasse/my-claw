import { readFile } from "node:fs/promises";
import { writeFileAtomically } from "../utils/atomic-write.ts";
import { isTracked, snapshot } from "../core/config-store.ts";
import { type Tool, type ToolResult, str, strOpt, bool } from "./types.ts";
import { resolveWorkspacePath } from "./workspace.ts";
import { formatError } from "../utils/errors.ts";
import { buildUnifiedDiff } from "../utils/unified-diff.ts";
import { hooks } from "../hooks/index.ts";

/** One anchored replacement. `old` is matched literally, never as a pattern. */
interface Edit {
  old: string;
  new: string;
  /** Every occurrence instead of the single one the tool otherwise demands. */
  all: boolean;
}

/** How many lines of the file to name around an ambiguous anchor, so the model can extend it. */
const AMBIGUITY_SAMPLE = 5;

function parseEdits(raw: unknown): { edits: Edit[]; error?: string } {
  if (!Array.isArray(raw)) return { edits: [], error: "edits must be an array of { old, new } objects." };
  const edits: Edit[] = [];
  for (const [index, entry] of raw.entries()) {
    if (!entry || typeof entry !== "object") return { edits: [], error: `edits[${index}] must be an object with old and new.` };
    const record = entry as Record<string, unknown>;
    const oldText = strOpt(record, "old");
    const newText = strOpt(record, "new");
    if (oldText === undefined) return { edits: [], error: `edits[${index}].old is required.` };
    if (newText === undefined) return { edits: [], error: `edits[${index}].new is required (use "" to delete the block).` };
    if (oldText === "") return { edits: [], error: `edits[${index}].old cannot be empty: anchor the edit on text that exists.` };
    if (oldText === newText) return { edits: [], error: `edits[${index}] changes nothing: old and new are identical.` };
    edits.push({ old: oldText, new: newText, all: bool(record, "all", false) });
  }
  if (edits.length === 0) return { edits: [], error: "edits is empty: nothing to apply." };
  return { edits };
}

function occurrences(haystack: string, needle: string): number {
  let count = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    count += 1;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return count;
}

/** 1-based lines an anchor starts on, so an ambiguity report points at real places in the file. */
function matchLines(haystack: string, needle: string): number[] {
  const lines: number[] = [];
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    lines.push(haystack.slice(0, at).split("\n").length);
    at = haystack.indexOf(needle, at + needle.length);
  }
  return lines;
}

export const applyPatchTool: Tool = {
  name: "apply_patch",
  description:
    "Edit an existing file by replacing exact text. Anchored, not line-numbered: each edit gives the " +
    "text to replace (old) and its replacement (new). The anchor must appear exactly once in the file " +
    "unless all=true, so include enough surrounding lines to be unique. All edits of one call apply " +
    "together or none does. Use this instead of rewriting a file with write.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute path to the file to edit" },
      edits: {
        type: "array",
        description: "Replacements applied in order, all or nothing",
        items: {
          type: "object",
          properties: {
            old: { type: "string", description: "Exact text to replace, unique in the file unless all=true" },
            new: { type: "string", description: "Replacement text; empty string deletes the block" },
            all: { type: "boolean", description: "Replace every occurrence instead of requiring a unique one" },
          },
          required: ["old", "new"],
        },
      },
    },
    required: ["path", "edits"],
  },
  async execute(args): Promise<ToolResult> {
    const path = str(args, "path");
    if (!path.trim()) return { success: false, output: "path is required and cannot be empty." };
    const parsed = parseEdits(args["edits"]);
    if (parsed.error) return { success: false, output: parsed.error };

    const resolved = resolveWorkspacePath(path, strOpt(args, "__workspaceDir"));

    let original: string;
    try {
      original = await readFile(resolved, "utf-8");
    } catch (e) {
      // A missing file is the one failure worth naming precisely: the model must switch to write,
      // not retry the same patch with a longer anchor.
      const missing = (e as NodeJS.ErrnoException).code === "ENOENT";
      return {
        success: false,
        output: "",
        error: missing ? `File not found: ${resolved}. Create it with write.` : formatError(`Failed to read "${resolved}"`, e),
      };
    }

    let next = original;
    const applied: string[] = [];
    for (const [index, edit] of parsed.edits.entries()) {
      const found = occurrences(next, edit.old);
      if (found === 0) {
        // Nothing is written: a partial patch is worse than a refused one, since the model would
        // then be reasoning about a file that is neither the old nor the new version.
        return {
          success: false,
          output: "",
          error:
            `edits[${index}]: anchor not found in ${resolved}. Nothing was written. ` +
            "Read the file again and copy the exact text, whitespace included.",
        };
      }
      if (found > 1 && !edit.all) {
        const lines = matchLines(next, edit.old).slice(0, AMBIGUITY_SAMPLE);
        return {
          success: false,
          output: "",
          error:
            `edits[${index}]: anchor appears ${found} times in ${resolved} (lines ${lines.join(", ")}` +
            `${found > lines.length ? ", ..." : ""}). Nothing was written. Extend the anchor with ` +
            "surrounding lines until it is unique, or pass all=true to replace every occurrence.",
        };
      }
      next = edit.all ? next.split(edit.old).join(edit.new) : next.replace(edit.old, edit.new);
      applied.push(`edits[${index}]: ${found} occurrence${found > 1 ? "s" : ""} replaced`);
    }

    if (next === original) {
      return { success: false, output: "", error: "The edits left the file unchanged; nothing was written." };
    }

    try {
      // Same guarantees as write: a tracked file keeps the version it is about to lose, and the
      // replacement lands atomically so a watcher never reads a half-written file.
      if (await isTracked(resolved)) {
        await snapshot(resolved, { origin: "tool", note: "apply_patch tool" });
      }
      await writeFileAtomically(resolved, next);
      hooks.emit("tool:file:write", { path: resolved, size: next.length });
    } catch (e) {
      return { success: false, output: "", error: formatError(`Failed to write "${resolved}"`, e) };
    }

    const before = original.split("\n").length;
    const after = next.split("\n").length;
    const delta = after - before;
    // The result of a patch is its diff: the app renders it red/green, and the model sees exactly
    // what changed rather than a re-echo of the whole file. Cosmetic only -- the file on disk is
    // the source of truth.
    const diff = buildUnifiedDiff(resolved, original, next);
    return {
      success: true,
      output:
        `Patched ${resolved} (${parsed.edits.length} edit${parsed.edits.length > 1 ? "s" : ""}, ` +
        `${before} -> ${after} lines${delta === 0 ? "" : `, ${delta > 0 ? "+" : ""}${delta}`}).\n` +
        (diff.length > 0 ? `${diff}\n` : "") +
        applied.join("\n"),
    };
  },
};
