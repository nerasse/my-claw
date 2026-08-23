import { access } from "node:fs/promises";
import { type Tool, type ToolResult, str, strOpt, bool, numOpt } from "./types.ts";
import { resolveWorkspacePath } from "./workspace.ts";
import { formatError } from "../utils/errors.ts";

const OUTPUT_LIMIT = 100_000;
/** Enough to read a function around a hit without turning a search into a file dump. */
const MAX_CONTEXT_LINES = 40;
/**
 * Entries returned before the result is cut. Claude Code's number, and measured against the run
 * that motivated this: 250 lines of hits is enough to answer "where is this" and small enough that
 * a wrong search costs a few hundred tokens instead of fifteen thousand.
 */
const DEFAULT_LIMIT = 250;
const MAX_LIMIT = 2000;
/**
 * A minified bundle or a base64 blob is one line long. Without a per-line cap a single hit inside
 * one can be the whole result.
 */
const MAX_LINE_CHARS = 500;
/** The depth `find` used before it was folded in here; deep enough for a repo, bounded for a home dir. */
const MAX_DEPTH = 10;

async function run(argv: string[], cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", cwd });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

function capped(output: string): string {
  return output.length > OUTPUT_LIMIT ? `${output.slice(0, OUTPUT_LIMIT)}\n[output truncated at 100KB]` : output;
}

function clip(line: string): string {
  return line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)} [...line truncated]` : line;
}

/**
 * Header, body, and -- when the body was cut -- what to do about it.
 *
 * The count comes first on purpose. A model that is handed 250 lines cannot tell whether it saw
 * everything or a fifth of it, so it either trusts a partial answer or re-runs the same search
 * wider. Saying "1 284 matches in 63 files" up front turns both of those into a decision.
 */
function render(header: string, lines: string[], limit: number, advice: string): string {
  const shown = lines.slice(0, limit);
  const body = shown.join("\n");
  if (lines.length <= limit) return capped(`${header}\n${body}`.trimEnd());
  return capped(
    `${header}\n${body}\n\n[showing the first ${limit} of ${lines.length}. ${advice}]`,
  );
}

/**
 * grep's regex complaints name the character and not the dialect, which leaves a model to guess
 * which flavour it should have written. Since the answer is always the same, say it.
 */
function patternError(stderr: string, pattern: string): string {
  const detail = stderr.trim() || "invalid pattern or unreadable path";
  if (/unmatched|unterminated|repetition|invalid|trailing backslash|brace/i.test(detail)) {
    return `${detail}\nPattern was ${JSON.stringify(pattern)}. This tool uses POSIX extended regex (ERE): parentheses, | and + are operators and must not be backslash-escaped, and PCRE classes like \\d or \\s are not supported -- use [0-9] and [[:space:]].`;
  }
  return detail;
}

export const searchTool: Tool = {
  name: "search",
  description:
    "Search the filesystem. `pattern` matches file contents (POSIX extended regex), `glob` filters " +
    "or, alone, lists files by name.\n" +
    "Modes: `files` (default) returns only the paths that match, `count` returns per-file match " +
    "counts, `content` returns the matching lines. Start with the default and switch to `content` " +
    "once the search is narrow: a broad `content` search is the single most expensive call this " +
    "agent can make.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory or file to search in" },
      pattern: {
        type: "string",
        description:
          "POSIX extended regex (ERE) matched against file contents: (a|b), +, ? and {n,m} work unescaped. " +
          "No PCRE classes -- write [0-9] and [[:space:]] rather than \\d and \\s. Omit to list files by name.",
      },
      glob: { type: "string", description: "File name pattern (e.g. *.ts): filters a content search, or lists files when alone" },
      mode: {
        type: "string",
        enum: ["files", "count", "content"],
        description:
          "files (default): matching paths only. count: matches per file. content: the matching lines themselves.",
      },
      limit: { type: "number", description: `Entries returned before the result is cut (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})` },
      context: { type: "number", description: "Lines of context around each match, content mode only (max 40)" },
      ignoreCase: { type: "boolean", description: "Case-insensitive match" },
      recursive: { type: "boolean", description: "Search subdirectories (default true)" },
    },
    required: ["path"],
  },
  async execute(args): Promise<ToolResult> {
    const path = str(args, "path");
    const pattern = str(args, "pattern").trim();
    const glob = str(args, "glob").trim();
    if (!path.trim()) return { success: false, output: "path is required and cannot be empty." };
    if (!pattern && !glob) {
      return { success: false, output: "pattern (file contents) or glob (file names) is required." };
    }

    const wsDir = strOpt(args, "__workspaceDir");
    let resolved: string;
    try {
      resolved = resolveWorkspacePath(path, wsDir);
    } catch (e) {
      return { success: false, output: "", error: String((e as Error).message) };
    }
    try {
      await access(resolved);
    } catch {
      return { success: false, output: `Path not found: ${resolved}. Check the path exists.` };
    }
    const cwd = wsDir ?? process.env["MY_CLAW_WORKSPACE"] ?? process.cwd();

    // Name search: no content pattern, so the glob is the whole query.
    if (!pattern) {
      try {
        const { stdout, stderr, exitCode } = await run(["find", resolved, "-maxdepth", String(MAX_DEPTH), "-name", glob], cwd);
        if (exitCode !== 0 && !stdout.trim()) {
          return { success: false, output: "", error: `find failed (exit ${exitCode}): ${stderr.trim() || "unreadable path or bad pattern"}` };
        }
        return { success: true, output: capped(stdout) || `No files matching ${JSON.stringify(glob)} under ${resolved}` };
      } catch (e) {
        return { success: false, output: "", error: formatError(`Failed to list files in "${resolved}"`, e) };
      }
    }

    /**
     * `-E`, and not grep's default.
     *
     * Plain grep is BRE, where `(`, `|`, `+` and `?` are literal characters. Models write ERE or
     * PCRE, so `(alpha|beta)` was being searched for as that exact eleven-character string: exit 1,
     * "No matches found", on a file containing both words. A wrong answer reported as a clean one,
     * which is the worst shape a tool failure can take -- the model believes it and searches
     * somewhere else. Measured on one run: forty "No matches found" and thirteen `Unmatched \(`
     * errors, all of them this.
     */
    const mode = (strOpt(args, "mode") ?? "files") as "files" | "count" | "content";
    const limit = Math.min(Math.max(1, Math.floor(numOpt(args, "limit") ?? DEFAULT_LIMIT)), MAX_LIMIT);

    /**
     * `-E`, and not grep's default.
     *
     * Plain grep is BRE, where `(`, `|`, `+` and `?` are literal characters. Models write ERE or
     * PCRE, so `(alpha|beta)` was being searched for as that exact eleven-character string: exit 1,
     * "No matches found", on a file containing both words. A wrong answer reported as a clean one,
     * which is the worst shape a tool failure can take -- the model believes it and searches
     * somewhere else. Measured on one run: forty "No matches found" and thirteen `Unmatched \(`
     * errors, all of them this.
     */
    const flags: string[] = ["-E"];
    if (bool(args, "recursive", true)) flags.push("-r");
    if (bool(args, "ignoreCase", false)) flags.push("-i");
    // One grep per mode rather than one grep post-filtered: `-l` stops at the first hit per file,
    // so the default mode is also by far the cheapest to run.
    if (mode === "files") flags.push("-l");
    else if (mode === "count") flags.push("-c");
    else {
      flags.push("-n");
      const context = numOpt(args, "context");
      // Context is honoured in content mode alone. Asked for beside `-l` or `-c` grep ignores it,
      // and a model that believes it received context reads a truncated answer as a complete one.
      if (context !== undefined && context > 0) flags.push(`-C${Math.min(Math.floor(context), MAX_CONTEXT_LINES)}`);
    }
    const filters = glob ? [`--include=${glob}`] : [];

    try {
      // "--" stops option parsing so a pattern starting with "-" is not read as a flag.
      const argv = ["grep", ...flags, "--max-count=1000", "--binary-files=without-match", ...filters, "--", pattern, resolved];
      const { stdout, stderr, exitCode } = await run(argv, cwd);
      // grep exit codes: 0 = matches, 1 = no matches (not an error), >=2 = real error.
      if (exitCode >= 2) {
        return { success: false, output: "", error: patternError(stderr, pattern) };
      }
      const lines = stdout.split("\n").filter((l) => l.length > 0);
      // Naming what was actually searched, because the bare string was not actionable: the model
      // could not see from it whether it had already tried this exact query, and forty of them in
      // one run is what that looks like.
      if (lines.length === 0) return { success: true, output: `No matches for ${JSON.stringify(pattern)} in ${resolved}` };

      if (mode === "files") {
        return {
          success: true,
          output: render(
            `${lines.length} file(s) contain ${JSON.stringify(pattern)}`,
            lines,
            limit,
            "narrow with glob or a deeper path",
          ),
        };
      }
      if (mode === "count") {
        // grep -c prints a line per searched file, zeroes included when several files are named.
        const hits = lines.filter((l) => !/:0$/.test(l));
        const total = hits.reduce((n, l) => n + (Number(l.slice(l.lastIndexOf(":") + 1)) || 0), 0);
        return {
          success: true,
          output: render(`${total} match(es) in ${hits.length} file(s)`, hits, limit, "narrow with glob or a deeper path"),
        };
      }
      return {
        success: true,
        output: render(
          `${lines.length} matching line(s)`,
          lines.map(clip),
          limit,
          'narrow the pattern, or re-run with mode "files" to see where the matches are first',
        ),
      };
    } catch (e) {
      return { success: false, output: "", error: formatError(`Failed to search in "${resolved}"`, e) };
    }
  },
};
