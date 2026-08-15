import { statSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { normalizeUntrusted } from "./normalize-untrusted.ts";

// Tools whose `path` argument is a deterministic signal for the directory being touched.
const PATH_TOOLS = new Set(["read", "write", "apply_patch", "ls", "search"]);
const AGENTS_FILE = "AGENTS.md";

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
  return isAbsolute(p) ? resolve(p) : resolve(workspaceDir, p);
}

/**
 * Determine the directory a tool call operates in, or null when there is no reliable signal.
 * File tools expose an explicit `path`; bash exposes `workdir` (else a leading `cd <path>`).
 */
export function extractTargetDir(
  toolName: string,
  args: Record<string, unknown>,
  workspaceDir: string,
): string | null {
  if (PATH_TOOLS.has(toolName)) {
    const path = args["path"];
    if (typeof path !== "string" || !path.trim()) return null;
    const resolved = resolveAgainstWorkspace(path, workspaceDir);
    return isDir(resolved) ? resolved : dirname(resolved);
  }

  if (toolName === "bash") {
    const workdir = args["workdir"];
    if (typeof workdir === "string" && workdir.trim()) {
      const resolved = resolveAgainstWorkspace(workdir, workspaceDir);
      return isDir(resolved) ? resolved : null;
    }
    // Fallback: only a leading `cd <path>` (discovery signal, not execution). Anything more
    // (parsing arbitrary tokens) invites false positives, so we deliberately stop here.
    const command = args["command"];
    if (typeof command === "string") {
      const m = command.match(/^\s*cd\s+(['"]?)([^'"&;|<>\n]+)\1/);
      if (m?.[2]) {
        const resolved = resolveAgainstWorkspace(m[2].trim(), workspaceDir);
        return isDir(resolved) ? resolved : null;
      }
    }
    return null;
  }

  return null;
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
 * Per-run collector for nested AGENTS.md discovery. Holds the dedup set and byte budget so
 * each file is injected at most once per run and the total stays under `maxBytes`. Lives as
 * a run-local instance (never on the persisted session).
 */
export class NestedAgentsCollector {
  private readonly seen = new Set<string>();
  private bytesUsed = 0;
  private readonly workspaceRoot: string;

  constructor(
    workspaceDir: string,
    private readonly maxBytes: number,
  ) {
    this.workspaceRoot = resolve(workspaceDir);
  }

  /**
   * Discover the AGENTS.md chain for a tool call and return a formatted block to append to
   * the tool result, or "" when there is nothing new to inject.
   */
  collect(toolName: string, args: Record<string, unknown>): string {
    if (this.bytesUsed >= this.maxBytes) return "";
    const targetDir = extractTargetDir(toolName, args, this.workspaceRoot);
    if (!targetDir) return "";

    const blocks: string[] = [];
    for (const dir of chainDirs(targetDir, this.workspaceRoot)) {
      if (dir === this.workspaceRoot) continue; // already in the system prompt
      const file = join(dir, AGENTS_FILE);
      if (this.seen.has(file) || !isFile(file)) continue;
      this.seen.add(file);

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
