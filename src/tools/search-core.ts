import { statSync } from "node:fs";
import { access } from "node:fs/promises";
import { basename, dirname } from "node:path";

/**
 * The search engine and its rendering, shared by the server tool (`search.ts`) and the
 * node-client tool, so one query reads the same wherever it runs (docs/search.md).
 *
 * ripgrep when it resolves (`ripgrep.ts`), GNU grep otherwise -- the caller says which, and the
 * fallback announces itself in the result instead of quietly answering with different rules.
 *
 * Each root runs as its own ripgrep call with cwd set to the root: a path glob then reads
 * relative to the root the way it does after a `cd` (ripgrep matches globs against the path
 * relative to its cwd, however it prints them), and a multi-root search keeps that meaning
 * for every root instead of only the first.
 */

export const OUTPUT_LIMIT = 100_000;
export const SEARCH_DEFAULT_LIMIT = 250;
export const SEARCH_MAX_LIMIT = 2000;
export const SEARCH_MAX_CONTEXT = 40;
const MAX_LINE_CHARS = 500;
const MAX_MATCHES_PER_FILE = 1000;
const MAX_LIST_DEPTH = 10;

/**
 * Directory names that are generated and rarely the answer: skipped everywhere unless `all` is
 * set. ripgrep's own defaults (hidden files, .gitignore/.ignore rules) sit on top of this list;
 * an explicit path INTO one of these directories is still searched, which ripgrep does natively.
 */
export const DEFAULT_IGNORES = ["node_modules", "__pycache__", "vendor", "target", "dist", "build", "coverage"];

export interface SearchQuery {
  roots: string[];
  pattern: string;
  glob: string;
  mode: "files" | "count" | "content";
  context: number;
  after: number;
  before: number;
  limit: number;
  offset: number;
  ignoreCase: boolean;
  extract: boolean;
  invert: boolean;
  all: boolean;
  exclude: string[];
  excludeDirs: string[];
}

export interface QueryEnvironment {
  rgPath: string | null;
}

// ── argument coercion ────────────────────────────────────────────────────────

function asStr(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  return String(value);
}

function asStrArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(asStr);
  if (typeof value === "string" && value.trim()) return [value];
  return [];
}

function asBool(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

function asInt(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Math.floor(Number(value));
  return fallback;
}

const clamp = (value: number, lo: number, hi: number) => Math.min(Math.max(value, lo), hi);

export function normalizeQuery(
  raw: Record<string, unknown>,
  opts: { resolveRoot: (input: string) => string; defaultRoot: string },
): { query: SearchQuery } | { error: string } {
  if (raw["searches"] !== undefined) return { error: "searches nests nothing; a batch is the outer object only." };

  const roots: string[] = [];
  if (raw["path"] !== undefined) {
    const pathArg = asStr(raw["path"]);
    if (!pathArg.trim()) return { error: "path cannot be empty: omit it to search the workspace, or name a directory." };
    roots.push(opts.resolveRoot(pathArg));
  }
  for (const entry of asStrArray(raw["paths"])) {
    if (!entry.trim()) return { error: "paths entries cannot be empty." };
    roots.push(opts.resolveRoot(entry));
  }
  if (roots.length === 0) roots.push(opts.defaultRoot);

  const pattern = asStr(raw["pattern"]).trim();
  const glob = asStr(raw["glob"]).trim();
  if (!pattern && !glob) {
    return { error: "pattern (file contents) or glob (file names) is required." };
  }

  const modeRaw = asStr(raw["mode"]).trim() || "files";
  if (modeRaw !== "files" && modeRaw !== "count" && modeRaw !== "content") {
    return { error: `mode must be files, count or content (got ${JSON.stringify(modeRaw)}).` };
  }

  const context = clamp(asInt(raw["context"], 0), 0, SEARCH_MAX_CONTEXT);
  const after = clamp(asInt(raw["after"], 0), 0, SEARCH_MAX_CONTEXT);
  const before = clamp(asInt(raw["before"], 0), 0, SEARCH_MAX_CONTEXT);
  if (context > 0 && (after > 0 || before > 0)) {
    return { error: "use context, or after/before, not both: context is symmetric." };
  }

  return {
    query: {
      roots,
      pattern,
      glob,
      mode: modeRaw,
      context,
      after,
      before,
      limit: clamp(asInt(raw["limit"], SEARCH_DEFAULT_LIMIT), 1, SEARCH_MAX_LIMIT),
      offset: Math.max(0, asInt(raw["offset"], 0)),
      ignoreCase: asBool(raw["ignoreCase"]),
      extract: asBool(raw["extract"]),
      invert: asBool(raw["invert"]),
      all: asBool(raw["all"]),
      exclude: asStrArray(raw["exclude"]).map((s) => s.trim()).filter(Boolean),
      excludeDirs: asStrArray(raw["excludeDirs"]).map((s) => s.trim()).filter(Boolean),
    },
  };
}

export async function firstMissingRoot(roots: string[]): Promise<string | null> {
  for (const root of roots) {
    try {
      await access(root);
    } catch {
      return root;
    }
  }
  return null;
}

// ── argument construction ────────────────────────────────────────────────────

/** `*.{ts,tsx}` is one shell habit GNU grep never learned; rg reads it natively. */
export function expandBraces(glob: string): string[] {
  const open = glob.indexOf("{");
  if (open === -1) return [glob];
  let depth = 0;
  let close = -1;
  for (let i = open; i < glob.length; i++) {
    if (glob[i] === "{") depth++;
    else if (glob[i] === "}") {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close === -1) return [glob];
  const prefix = glob.slice(0, open);
  const suffix = glob.slice(close + 1);
  const parts: string[] = [];
  let current = "";
  let nested = 0;
  for (const ch of glob.slice(open + 1, close)) {
    if (ch === "{") nested++;
    if (ch === "}") nested--;
    if (ch === "," && nested === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);
  const out: string[] = [];
  for (const part of parts) out.push(...expandBraces(prefix + part + suffix));
  return out;
}

export function buildRipgrepArgv(query: SearchQuery): string[] {
  const argv = ["--color=never", "-H", "--no-require-git", "--sort", "path"];
  if (query.all) argv.push("--no-ignore", "--hidden");
  else for (const name of DEFAULT_IGNORES) argv.push("--glob", `!${name}`);
  for (const pattern of query.exclude) argv.push("--glob", `!${pattern}`);
  for (const name of query.excludeDirs) argv.push("--glob", `!${name}`);
  if (query.glob) argv.push("--glob", query.glob);
  if (query.ignoreCase) argv.push("-i");
  if (query.invert) argv.push("-v");

  if (!query.pattern) {
    argv.push("--files", ...query.roots);
    return argv;
  }

  if (query.mode === "files") {
    argv.push("-l");
  } else if (query.mode === "count") {
    argv.push("-c", "-m", String(MAX_MATCHES_PER_FILE));
  } else {
    argv.push("-n");
    if (query.extract) argv.push("-o");
    if (query.context > 0) argv.push("-C", String(query.context));
    if (query.after > 0) argv.push("-A", String(query.after));
    if (query.before > 0) argv.push("-B", String(query.before));
    argv.push("-m", String(MAX_MATCHES_PER_FILE));
  }
  argv.push("--", query.pattern, ...query.roots);
  return argv;
}

export function buildGrepArgv(query: SearchQuery): { argv: string[] } | { error: string } {
  // `grep --exclude-dir` prunes a directory it is also given as an explicit root (ripgrep does
  // not), so a name that IS a root is never turned into an exclude rule: the exact path a caller
  // named gets searched, in either engine.
  const rootNames = new Set(query.roots.map((root) => basename(root)));

  if (!query.pattern) {
    const argv = ["find", ...query.roots, "-maxdepth", String(MAX_LIST_DEPTH)];
    const pruned = [...(query.all ? [] : [".git", ...DEFAULT_IGNORES]), ...query.excludeDirs].filter((name) => !rootNames.has(name));
    if (pruned.length > 0) {
      argv.push("(", "-name", pruned[0]!, ...pruned.slice(1).flatMap((name) => ["-o", "-name", name]), ")", "-prune", "-o");
    }
    argv.push("-type", "f");
    const names = query.glob ? expandBraces(query.glob) : [];
    if (names.length > 0) {
      argv.push("(", "-name", names[0]!, ...names.slice(1).flatMap((name) => ["-o", "-name", name]), ")");
    }
    for (const pattern of query.exclude.flatMap(expandBraces)) argv.push("!", "-name", pattern);
    argv.push("-print");
    return { argv };
  }

  const includes = query.glob ? expandBraces(query.glob) : [];
  if (includes.some((g) => g.includes("/"))) {
    return { error: "path-based globs need ripgrep, and ripgrep is unavailable on this machine." };
  }

  const argv = ["grep", "-E", "-r"];
  if (query.ignoreCase) argv.push("-i");
  if (query.invert) argv.push("-v");
  if (query.mode === "files") {
    argv.push("-l");
  } else if (query.mode === "count") {
    argv.push("-c", `--max-count=${MAX_MATCHES_PER_FILE}`);
  } else {
    argv.push("-n");
    if (query.extract) argv.push("-o");
    if (query.context > 0) argv.push(`-C${query.context}`);
    if (query.after > 0) argv.push(`-A${query.after}`);
    if (query.before > 0) argv.push(`-B${query.before}`);
    argv.push(`--max-count=${MAX_MATCHES_PER_FILE}`);
  }
  argv.push("--binary-files=without-match");
  if (!query.all && !rootNames.has(".git")) argv.push("--exclude-dir=.git");
  const dirs = [...(query.all ? [] : DEFAULT_IGNORES), ...query.excludeDirs].filter((name) => !rootNames.has(name));
  for (const name of dirs) argv.push(`--exclude-dir=${name}`);
  for (const include of includes) argv.push(`--include=${include}`);
  for (const pattern of query.exclude.flatMap(expandBraces)) argv.push(`--exclude=${pattern}`);
  argv.push("--", query.pattern, ...query.roots);
  return { argv };
}

// ── execution and rendering ─────────────────────────────────────────────────

async function run(argv: string[], cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", cwd });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

function cwdFor(root: string): string {
  try {
    return statSync(root).isDirectory() ? root : dirname(root);
  } catch {
    return dirname(root);
  }
}

export function capOutput(text: string): string {
  return text.length > OUTPUT_LIMIT ? `${text.slice(0, OUTPUT_LIMIT)}\n[output truncated at 100KB]` : text;
}

function clip(line: string): string {
  return line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)} [...line truncated]` : line;
}

/**
 * The count comes first on purpose: a model handed 250 lines cannot tell whether it saw
 * everything or a fifth of it, so it either trusts a partial answer or re-runs wider. Saying
 * "1 284 matches in 63 files" up front turns both into a decision. A page (offset set, or a
 * result cut by limit) is always labelled: an unlabelled short list reads as the whole answer.
 */
function render(header: string, lines: string[], offset: number, limit: number, advice: string): string {
  const start = Math.min(offset, lines.length);
  const shown = lines.slice(start, start + limit);
  const body = shown.join("\n");
  const cut = lines.length > start + shown.length;
  if (offset === 0 && !cut) return capOutput(`${header}\n${body}`.trimEnd());
  const range =
    shown.length === 0
      ? `offset ${offset} is past the ${lines.length} results`
      : `showing results ${start + 1}-${start + shown.length} of ${lines.length}`;
  const next = cut ? ` Continue with offset ${start + shown.length}.` : "";
  return capOutput(`${header}\n${body}\n\n[${range}.${next} ${advice}]`);
}

function ignoredNote(query: SearchQuery): string {
  return `\nskipped by default: ${DEFAULT_IGNORES.join(", ")}, hidden files, .gitignore rules: all: true searches them too`;
}

function noMatchesText(query: SearchQuery): string {
  const roots = query.roots.join(", ");
  const suffix = query.pattern && query.glob ? ` (glob ${JSON.stringify(query.glob)})` : "";
  const base = query.pattern
    ? `No matches for ${JSON.stringify(query.pattern)} in ${roots}${suffix}`
    : `No files matching ${JSON.stringify(query.glob)} under ${roots}`;
  return query.all ? base : base + ignoredNote(query);
}

function fallbackBanner(): string {
  return "[engine: grep fallback, ripgrep unavailable: hidden files are searched and .gitignore rules are not applied]\n";
}

/**
 * `grep`'s regex complaints name the character and not the dialect, which leaves a model to guess
 * which flavour it should have written. rg's are clearer, and its dialect is the one to name.
 */
function patternError(stderr: string, engine: "rg" | "grep", pattern: string): string {
  const detail = stderr.trim() || "invalid pattern or unreadable path";
  if (engine === "rg" && /regex parse error|error parsing|unclosed|repetition|escape/i.test(detail)) {
    return `${detail}\nPattern was ${JSON.stringify(pattern)}. The engine is Rust regex: \\d, \\s, \\w and \\b work; lookaround and backreferences are not supported.`;
  }
  if (engine === "grep" && /unmatched|unterminated|repetition|invalid|trailing backslash|brace/i.test(detail)) {
    return `${detail}\nPattern was ${JSON.stringify(pattern)}. The grep fallback uses POSIX extended regex (ERE): parentheses, | and + are operators and must not be backslash-escaped, and PCRE classes like \\d or \\s are not supported -- use [0-9] and [[:space:]].`;
  }
  return detail;
}

interface EngineResult {
  ok: boolean;
  error?: string;
  lines: string[];
}

async function collectRipgrep(root: string, query: SearchQuery, rgPath: string): Promise<EngineResult> {
  const single = { ...query, roots: [root] };
  let result: { stdout: string; stderr: string; exitCode: number };
  try {
    result = await run([rgPath, ...buildRipgrepArgv(single)], cwdFor(root));
  } catch (error) {
    return { ok: false, error: `Failed to run ripgrep: ${error instanceof Error ? error.message : String(error)}`, lines: [] };
  }
  if (result.exitCode >= 2) {
    return { ok: false, error: patternError(result.stderr, "rg", query.pattern), lines: [] };
  }
  const lines = result.stdout
    .split("\n")
    .filter((line) => line.length > 0 && !/^binary file .* matches/.test(line));
  return { ok: true, lines };
}

async function collectGrep(root: string, query: SearchQuery): Promise<EngineResult> {
  const single = { ...query, roots: [root] };
  const built = buildGrepArgv(single);
  if ("error" in built) return { ok: false, error: built.error, lines: [] };
  let result: { stdout: string; stderr: string; exitCode: number };
  try {
    result = await run(built.argv, cwdFor(root));
  } catch (error) {
    return { ok: false, error: `Failed to run grep: ${error instanceof Error ? error.message : String(error)}`, lines: [] };
  }
  if (result.exitCode >= 2) {
    return { ok: false, error: fallbackBanner() + patternError(result.stderr, "grep", query.pattern), lines: [] };
  }
  return { ok: true, lines: result.stdout.split("\n").filter((line) => line.length > 0) };
}

export async function executeQuery(query: SearchQuery, env: QueryEnvironment): Promise<{ ok: boolean; text: string }> {
  const fallback = env.rgPath === null;
  const banner = fallback ? fallbackBanner() : "";
  const collected: string[] = [];
  for (const root of query.roots) {
    const result = fallback ? await collectGrep(root, query) : await collectRipgrep(root, query, env.rgPath!);
    if (!result.ok) {
      const where = query.roots.length > 1 ? ` (root ${root})` : "";
      return { ok: false, text: `${result.error ?? "search failed"}${where}` };
    }
    collected.push(...result.lines);
  }
  return { ok: true, text: banner + renderLines(query, collected) };
}

/** Mode-aware rendering over already-collected engine lines, so a fallback engine answers in the same shape. */
export function renderLines(query: SearchQuery, lines: string[]): string {
  if (lines.length === 0) return noMatchesText(query);

  const adviceFiles = "narrow with glob or a deeper path";
  const adviceContent = 'narrow the pattern, or re-run with mode "files" to see where the matches are first';

  if (!query.pattern) {
    return render(`${lines.length} file(s) match ${JSON.stringify(query.glob || "*")}`, lines, query.offset, query.limit, adviceFiles);
  }
  if (query.mode === "files") {
    return render(`${lines.length} file(s) contain ${JSON.stringify(query.pattern)}`, lines, query.offset, query.limit, adviceFiles);
  }
  if (query.mode === "count") {
    const hits = lines.filter((line) => !/:0$/.test(line));
    if (hits.length === 0) return noMatchesText(query);
    const total = hits.reduce((sum, line) => sum + (Number(line.slice(line.lastIndexOf(":") + 1)) || 0), 0);
    return render(`${total} match(es) in ${hits.length} file(s)`, hits, query.offset, query.limit, adviceFiles);
  }
  const label = query.extract ? "extracted match(es)" : "matching line(s)";
  return render(`${lines.length} ${label}`, lines.map(clip), query.offset, query.limit, adviceContent);
}

/** One shared output budget across a batch: the last queries are named as cut, never silently dropped. */
export function joinBatch(parts: { header: string; text: string }[]): string {
  const blocks: string[] = [];
  let used = 0;
  for (let i = 0; i < parts.length; i++) {
    const block = `${parts[i]!.header}\n${parts[i]!.text}`;
    if (used + block.length > OUTPUT_LIMIT) {
      blocks.push(`[batch cut at query ${i + 1} of ${parts.length}: the shared ${Math.round(OUTPUT_LIMIT / 1000)}KB output budget was reached]`);
      break;
    }
    blocks.push(block);
    used += block.length + 2;
  }
  return blocks.join("\n\n");
}

export function describeQuery(query: SearchQuery): string {
  const bits = [`${query.mode}`];
  if (query.pattern) bits.push(`pattern ${JSON.stringify(query.pattern)}`);
  if (query.glob) bits.push(`glob ${JSON.stringify(query.glob)}`);
  bits.push(`in ${query.roots.join(", ")}`);
  if (query.all) bits.push("all");
  return bits.join(" ");
}
