import { statSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { normalizeUntrusted } from "./normalize-untrusted.ts";

// Tools whose `path` argument is a deterministic signal for the directory being touched.
const PATH_TOOLS = new Set(["read", "write", "apply_patch", "ls", "search"]);
const AGENTS_FILE = "AGENTS.md";
/** One call may name several trees; a pathological command must not drain the run's budget. */
const MAX_DIRS_PER_CALL = 4;
/** Upper bound on the stat calls one command may cost, whatever its length. */
const MAX_TOKENS_SCANNED = 60;
/**
 * Anything holding a slash: `src/tools/x.ts`, `/opt/my-claw`, `~/dev/repo`, `./sub`. What it is
 * gets decided by the filesystem, not by this pattern, so it stays deliberately loose.
 */
const PATH_TOKEN = /(?:~|\.{0,2})?\/?[\w.@+-]*(?:\/[\w.@+-]+)+\/?/g;
/** Every `cd <path>`, not only a leading one: `make && cd sub && test` names `sub` too. */
const CD_TOKEN = /(?:^|[;&|]|&&|\|\|)\s*cd\s+(['"]?)([^'"&;|<>\n]+)\1/g;

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** The path with every symlink resolved, or the path itself when it cannot be resolved. */
function realPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

// `.git` is a directory in a normal clone and a file in a submodule/worktree; accept both.
function hasGit(dir: string): boolean {
  try {
    statSync(join(dir, ".git"));
    return true;
  } catch {
    return false;
  }
}

function resolveAgainstWorkspace(p: string, workspaceDir: string): string {
  // `~` is the shell's, not the filesystem's: a command carries it unexpanded and the tools
  // resolve everything else against the workspace.
  const expanded = p.startsWith("~/") || p === "~" ? join(homedir(), p.slice(1)) : p;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(workspaceDir, expanded);
}

/** The directory a path names: itself when it is one, its parent when it is a file, else null. */
function dirOf(path: string, workspaceDir: string): string | null {
  const resolved = resolveAgainstWorkspace(path, workspaceDir);
  if (isDir(resolved)) return resolved;
  if (isFile(resolved)) return dirname(resolved);
  return null;
}

function pushDir(dirs: string[], dir: string | null): void {
  if (dir && !dirs.includes(dir) && dirs.length < MAX_DIRS_PER_CALL) dirs.push(dir);
}

/**
 * Directories a tool call operates in, empty when nothing on the call names a real one.
 *
 * File tools expose an explicit `path`. bash is read from three angles, because a run measured
 * on 2026-08-15 (1162 bash calls) used `workdir` exactly zero times, opened with `cd` in 66% of
 * calls, and named an existing path somewhere else in the command in another 33%: the parameter
 * built for this is not what the model reaches for, so the command itself has to be read.
 *
 * Arbitrary token parsing was rejected in the original design over false positives. The answer
 * is the filesystem: a token is kept only if it resolves to something that exists, so a "false
 * positive" is by construction a real directory the command names, which is the signal wanted.
 * Bounded by MAX_TOKENS_SCANNED stat calls and MAX_DIRS_PER_CALL results.
 */
export function extractTargetDirs(
  toolName: string,
  args: Record<string, unknown>,
  workspaceDir: string,
): string[] {
  const dirs: string[] = [];

  if (PATH_TOOLS.has(toolName)) {
    const path = args["path"];
    if (typeof path !== "string" || !path.trim()) return dirs;
    // A path that does not exist yet is still a signal: `write` creates it, and the rules of the
    // tree it lands in are what the model needs before writing.
    const resolved = resolveAgainstWorkspace(path, workspaceDir);
    pushDir(dirs, isDir(resolved) ? resolved : dirname(resolved));
    return dirs;
  }

  // A sub-agent given a workspace works in that tree for its whole life.
  if (toolName === "spawn") {
    const dir = args["workspaceDir"];
    if (typeof dir === "string" && dir.trim()) pushDir(dirs, dirOf(dir, workspaceDir));
    return dirs;
  }

  if (toolName !== "bash") return dirs;

  const workdir = args["workdir"];
  if (typeof workdir === "string" && workdir.trim()) pushDir(dirs, dirOf(workdir, workspaceDir));

  const command = args["command"];
  if (typeof command !== "string") return dirs;

  for (const match of command.matchAll(CD_TOKEN)) {
    const target = match[2]?.trim();
    if (target) pushDir(dirs, dirOf(target, workspaceDir));
  }

  let scanned = 0;
  for (const match of command.matchAll(PATH_TOKEN)) {
    if (scanned >= MAX_TOKENS_SCANNED || dirs.length >= MAX_DIRS_PER_CALL) break;
    scanned += 1;
    // Trailing punctuation belongs to the sentence, not to the path.
    pushDir(dirs, dirOf(match[0].replace(/[.,;:]+$/, ""), workspaceDir));
  }
  return dirs;
}

// Ordered list of directories from the git-root boundary down to `targetDir` (inclusive),
// root first. Without a git root, bound the walk at the workspace (if inside it) or at
// targetDir itself (outside), never walking up into arbitrary parents like /home.
function chainDirs(targetDir: string, workspaceDir: string): string[] {
  let boundary: string | null = null;
  let cur = targetDir;
  while (true) {
    if (hasGit(cur)) {
      boundary = cur;
      break;
    }
    const parent = dirname(cur);
    if (parent === cur) break; // filesystem root
    cur = parent;
  }
  if (!boundary) {
    boundary = targetDir.startsWith(workspaceDir + "/") || targetDir === workspaceDir
      ? workspaceDir
      : targetDir;
  }

  const dirs: string[] = [];
  let d = targetDir;
  while (true) {
    dirs.push(d);
    if (d === boundary) break;
    const parent = dirname(d);
    if (parent === d) break;
    d = parent;
  }
  return dirs.reverse();
}

/**
 * What a session remembers of the nested AGENTS.md its runs read. The collector dedups per run,
 * so `count` is the number of runs that paid for the file again, not the number of tool calls.
 */
export interface NestedAgentsRecord {
  /** Absolute, symlinks resolved: the identity the collector dedups on. */
  path: string;
  bytes: number;
  firstAt: string;
  lastAt: string;
  count: number;
}

/** A session is a JSON file rewritten on every turn: the trace must not grow without end. */
export const MAX_NESTED_RECORDS = 60;

/**
 * Folds one injection into a session's trace, in place. Over the cap the least recently injected
 * file is dropped: the page answers "what is loaded now", so the oldest entry is the one whose
 * absence costs the least.
 */
export function recordNestedInjection(
  records: NestedAgentsRecord[],
  file: { path: string; bytes: number },
  at: string = new Date().toISOString(),
): void {
  const existing = records.find((r) => r.path === file.path);
  if (existing) {
    existing.bytes = file.bytes;
    existing.lastAt = at;
    existing.count += 1;
    return;
  }
  records.push({ path: file.path, bytes: file.bytes, firstAt: at, lastAt: at, count: 1 });
  if (records.length > MAX_NESTED_RECORDS) {
    let oldest = 0;
    for (let i = 1; i < records.length; i += 1) {
      if (records[i]!.lastAt < records[oldest]!.lastAt) oldest = i;
    }
    records.splice(oldest, 1);
  }
}

/**
 * Per-run collector for nested AGENTS.md discovery. Holds the dedup set and byte budget so
 * each file is injected at most once per run and the total stays under `maxBytes`. Lives as
 * a run-local instance (never on the persisted session).
 */
export class NestedAgentsCollector {
  private readonly seen = new Set<string>();
  private bytesUsed = 0;
  private readonly workspaceRoot: string;

  /**
   * @param onInject Called once per file actually appended to a tool result. The collector stays
   * run-local, but the session has to remember what was read into it: without this the only trace
   * of an injected file is inside a tool result the owner may never scroll back to.
   */
  constructor(
    workspaceDir: string,
    private readonly maxBytes: number,
    private readonly onInject?: (file: { path: string; bytes: number }) => void,
  ) {
    this.workspaceRoot = resolve(workspaceDir);
  }

  /**
   * Discover the AGENTS.md chain for a tool call and return a formatted block to append to
   * the tool result, or "" when there is nothing new to inject.
   */
  collect(toolName: string, args: Record<string, unknown>): string {
    if (this.bytesUsed >= this.maxBytes) return "";
    const targetDirs = extractTargetDirs(toolName, args, this.workspaceRoot);
    if (targetDirs.length === 0) return "";

    const chain: string[] = [];
    for (const target of targetDirs) {
      for (const dir of chainDirs(target, this.workspaceRoot)) {
        if (!chain.includes(dir)) chain.push(dir);
      }
    }

    const blocks: string[] = [];
    for (const dir of chain) {
      if (dir === this.workspaceRoot) continue; // already in the system prompt
      const file = join(dir, AGENTS_FILE);
      if (!isFile(file)) continue;
      // Keyed on the real file: the same instructions reached through a symlink, or through two
      // spellings of one path, are one file and must not be paid for twice.
      const key = realPath(file);
      if (this.seen.has(key)) continue;
      this.seen.add(key);

      let content: string;
      try {
        content = readFileSync(file, "utf-8").trim();
      } catch {
        continue;
      }
      if (!content) continue;

      const size = Buffer.byteLength(content, "utf-8");
      if (this.bytesUsed + size > this.maxBytes) {
        this.bytesUsed = this.maxBytes; // cap reached: skip this and any further file this run
        break;
      }
      this.bytesUsed += size;
      this.onInject?.({ path: key, bytes: size });
      blocks.push(`--- ${AGENTS_FILE} (${file}) ---\n${normalizeUntrusted(content, file)}`);
    }

    if (blocks.length === 0) return "";
    return (
      "\n\n[Local project instructions discovered for this path. They extend the base rules; " +
      "core directives and the user's request always take precedence, and closer files override " +
      "farther ones.]\n\n" +
      blocks.join("\n\n")
    );
  }
}
