/**
 * File snapshots for `/undo` -- docs/session-log.md §7.
 *
 * One shadow git repository per project depot under the workspace, never one global snapshot.
 * A single `git add --all` from the workspace root would capture nested repositories as gitlinks
 * instead of their trees, which is exactly the bug opencode's single-repo design has -- measured
 * in §7.2. The workspace root itself is always a depot: when it is not a git repo, the shadow is
 * initialised there and the nested depots are excluded from it via `info/exclude`, so their trees
 * are captured once, by their own shadow.
 *
 * A snapshot is a list of `{root, treeId}`: the identity of the restored state is the set of tree
 * ids, not one id. Diff and restore both run per depot, in the order the depots were discovered.
 */

import { execFile } from "node:child_process";
import { mkdir, readdir, stat, writeFile, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * One capture at a time per shadow repository, keyed by its directory.
 *
 * Git's index is a file with a lock beside it: two `add --all` on one shadow interleave through
 * `index.lock`, and one of them loses its whole update instead of failing loudly. That was fine
 * while every capture sat inside a run's own path, and stopped being fine the moment the
 * end-of-run capture became fire-and-forget: a run ending while the next one starts is two
 * captures of the same depot at once. Measured 3 divergences in 20 with the race in place, and
 * a diff that then reports no change for a file that did change.
 */
const captureLocks = new Map<string, Promise<void>>();

async function withShadowLock<T>(shadowDir: string, work: () => Promise<T>): Promise<T> {
  const previous = captureLocks.get(shadowDir) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = previous.catch(() => {}).then(() => mine);
  captureLocks.set(shadowDir, chained);
  await previous.catch(() => {});
  try {
    return await work();
  } finally {
    release();
    if (captureLocks.get(shadowDir) === chained) captureLocks.delete(shadowDir);
  }
}

/** Max depth relative to the workspace root: `~/dev/<repo>` = 1, a monorepo `packages/<x>/` = 3. */
const DEPOT_MAX_DEPTH = 3;
/** Untracked files larger than this stay out of the snapshot, like opencode's default (2 MB). */
const MAX_UNTRACKED_BYTES = 2 * 1024 * 1024;

export interface DepotSnapshot {
  /** Absolute path of the depot root (a git repo, or the workspace root itself). */
  root: string;
  /** The git tree id captured at that root. */
  treeId: string;
}

export interface WorkspaceSnapshot {
  root: string;
  depots: DepotSnapshot[];
  /** Epoch ms. */
  ts: number;
}

export interface DepotDiff {
  root: string;
  /**
   * Files that differ, whatever they hold. The line counts below cannot say it: a binary, an
   * emptied file or a mode change is +0/-0, and a restore still rewrites it.
   */
  files: number;
  additions: number;
  deletions: number;
}

/** One git command against a depot's own shadow, from outside the worktree (GIT_DIR/GIT_WORK_TREE). */
async function shadowGit(
  shadowDir: string,
  workTree: string,
  args: string[],
): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    env: { ...process.env, GIT_DIR: shadowDir, GIT_WORK_TREE: workTree },
  });
  return stdout.trim();
}

function isGitRepo(dir: string): Promise<boolean> {
  return stat(join(dir, ".git"))
    .then(() => true)
    .catch(() => false);
}

/**
 * Discovers the git repositories under `root`, depth ≤ DEPOT_MAX_DEPTH, skipping nested depots
 * once one is found (a nested repo is its own depot, not part of the parent's tree). `root`
 * itself is not returned: the caller decides whether it is a depot.
 */
async function discoverNestedDepots(root: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > DEPOT_MAX_DEPTH) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === ".git" || entry.name === "node_modules") continue;
      const child = join(dir, entry.name);
      if (await isGitRepo(child)) {
        found.push(child);
        continue; // do not descend into a nested depot
      }
      await walk(child, depth + 1);
    }
  }
  await walk(root, 0);
  return found;
}

function hash(input: string): string {
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = (h * 31 + input.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

/**
 * The untracked files of a depot that are too big to belong in a snapshot.
 *
 * Read off git's own idea of what is untracked, never off a walk of the tree. The walk cost a
 * `readdir` and a `stat` per file of the whole workspace -- 3.7 s on a 33k-file tree, 12 s on a
 * 88k-file one -- and it ran twice per run, at both ends, inside the run's own lifecycle: a
 * stopped run spent its whole wind-down there (2026-11-12, 26 s between the abort and the stop
 * being reported). Git already knows which files are untracked, and it walks natively.
 *
 * The paths come back relative to the depot root, which is what `info/exclude` wants.
 */
async function oversizedUntracked(shadowDir: string, workTree: string): Promise<string[]> {
  let listed: string;
  try {
    ({ stdout: listed } = await execFileAsync(
      "git",
      ["ls-files", "--others", "--exclude-standard", "-z"],
      { env: { ...process.env, GIT_DIR: shadowDir, GIT_WORK_TREE: workTree }, maxBuffer: 64 * 1024 * 1024 },
    ));
  } catch {
    // A depot git cannot read has nothing to cap; the capture below omits it either way.
    return [];
  }
  const out: string[] = [];
  for (const name of listed.split("\0")) {
    if (!name) continue;
    const size = await stat(join(workTree, name)).then((s) => s.size).catch(() => 0);
    if (size > MAX_UNTRACKED_BYTES) out.push(`/${name}`);
  }
  return out;
}

/** Initialises the shadow of a depot if needed. */
async function ensureShadow(shadowDir: string, workTree: string): Promise<void> {
  await mkdir(shadowDir, { recursive: true }).catch(() => {});
  try {
    await shadowGit(shadowDir, workTree, ["init", "-q"]);
  } catch {
    // Already initialised; a hot index is exactly the point.
  }
}

/**
 * The shadow's whole exclude file: the nested depots it must not swallow, then the untracked
 * files past the size cap.
 *
 * Written whole, from what this capture computed. It used to read the file and append, so every
 * capture added its own copy of the same lines: 4080 lines for 1371 distinct paths after a few
 * runs, growing for good. The file is derived state, and deriving it is the only way two captures
 * of one depot can agree.
 *
 * The lines already there are re-checked rather than replaced by what git reports, and that is not
 * belt-and-braces: `info/exclude` is one of git's own exclusion sources, so a file this function
 * excluded a moment ago is *no longer untracked* as far as `ls-files --others --exclude-standard`
 * is concerned. Deriving only from git's answer made the second capture drop the line and the third
 * capture take the 2 GB blob it was there to keep out. A line survives while its file is still
 * there and still too big, which also bounds the file to the big files actually present.
 */
async function writeShadowExcludes(shadowDir: string, workTree: string, nested: string[]): Promise<void> {
  const file = join(shadowDir, "info", "exclude");
  const existing = await readFile(file, "utf8").catch(() => "");
  const kept: string[] = [];
  for (const line of existing.split("\n")) {
    const name = line.trim();
    // A nested depot's line ends with a slash and stays as it is; a capped file is re-measured.
    if (!name) continue;
    if (name.endsWith("/")) {
      kept.push(name);
      continue;
    }
    const size = await stat(join(workTree, name.slice(1))).then((s) => s.size).catch(() => 0);
    if (size > MAX_UNTRACKED_BYTES) kept.push(name);
  }
  const lines = nested.map((dir) => `/${relative(workTree, dir)}/`);
  lines.push(...kept, ...await oversizedUntracked(shadowDir, workTree));
  const body = [...new Set(lines)].sort().join("\n");
  if (existing.trim() === body) return;
  await mkdir(dirname(file), { recursive: true }).catch(() => {});
  await writeFile(file, body, "utf8").catch(() => {});
}

/**
 * Captures the current state of every depot under `workspace` into its own shadow repository.
 *
 * The shadows live under `shadowsRoot`: one directory per depot path (hashed), so a second
 * capture of the same depot reuses the warm index. The first capture of a depot does a full
 * `add --all`; after that the index is hot and a capture is a few milliseconds.
 *
 * Never throws: a snapshot that cannot be taken must not take a run down. Returns a snapshot
 * with zero depots when git is unavailable.
 */
export async function captureWorkspace(workspace: string, shadowsRoot: string): Promise<WorkspaceSnapshot> {
  const root = resolve(workspace);
  const nested = await discoverNestedDepots(root);
  const rootIsRepo = await isGitRepo(root);

  const depots: DepotSnapshot[] = [];
  // The workspace root is always a depot: a plain folder gets its own shadow so files the agent
  // creates directly under it are still restorable.
  depots.push({ root, treeId: "" });
  for (const nestedRoot of nested) {
    depots.push({ root: nestedRoot, treeId: "" });
  }

  // Collected rather than spliced out of the list being walked: removing a failed depot from it
  // skipped the next one, which stayed in the snapshot with an empty tree no restore can read.
  const captured: DepotSnapshot[] = [];
  for (const depot of depots) {
    const shadowDir = join(shadowsRoot, "shadow", hash(depot.root));
    // One writer per shadow: the exclude rewrite, the index and `write-tree` are one transaction
    // on one repository, and a second capture entering halfway corrupts all three.
    const treeId = await withShadowLock(shadowDir, async () => {
      await ensureShadow(shadowDir, depot.root);
      // A non-repo workspace root holding repos: `git add --all` would warn and record gitlinks.
      // Excluding them keeps the root shadow to its own files, the nested trees go to their shadows.
      await writeShadowExcludes(shadowDir, depot.root, depot.root === root && !rootIsRepo ? nested : []);
      try {
        await shadowGit(shadowDir, depot.root, [
          "-c", "core.autocrlf=false",
          "-c", "safe.directory=*",
          "add", "--all",
        ]);
        return await shadowGit(shadowDir, depot.root, ["write-tree"]);
      } catch {
        // A depot that cannot be captured is left out of the snapshot, not fatal: the workspace
        // may contain a repo the shadow cannot read. The undo still covers the rest.
        return undefined;
      }
    });
    if (treeId !== undefined) captured.push({ root: depot.root, treeId });
  }

  return { root, depots: captured, ts: Date.now() };
}

/**
 * Diff between two snapshots of the same root, "before -> after", per depot.
 *
 * Throws when git cannot read the trees. It used to answer "no change" instead, which is how a
 * wrong shadow directory went unnoticed: every diff /undo showed was +0/-0 (2026-10-02).
 */
export async function diffSnapshots(
  before: WorkspaceSnapshot,
  after: WorkspaceSnapshot,
  shadowsRoot: string,
): Promise<DepotDiff[]> {
  const out: DepotDiff[] = [];
  for (const depot of before.depots) {
    const afterDepot = after.depots.find((d) => d.root === depot.root);
    if (!afterDepot) continue;
    const shadowDir = join(shadowsRoot, "shadow", hash(depot.root));
    const { stdout } = await execFileAsync(
      "git",
      ["diff-tree", "--numstat", depot.treeId, afterDepot.treeId],
      { env: { ...process.env, GIT_DIR: shadowDir } },
    );
    const lines = stdout.trim().split("\n").filter(Boolean);
    let additions = 0;
    let deletions = 0;
    for (const line of lines) {
      const [add, del] = line.split("\t");
      // A binary has no line counts ("-"), and is still one of the files.
      additions += Number(add) || 0;
      deletions += Number(del) || 0;
    }
    out.push({ root: depot.root, files: lines.length, additions, deletions });
  }
  return out;
}

/**
 * Restores the worktree state of one depot to the given tree id.
 *
 * `read-tree` puts the tree in the shadow's index, `checkout-index -f` rewrites the worktree
 * files to it, `clean -fd` removes files that were created after the snapshot (they are untracked
 * in the shadow's index, so clean is exactly the faithful "back to before"). Ignored files
 * (node_modules, build output matching .gitignore) are never touched, which is the safety line
 * the restore must not cross: reaching into them would delete build artifacts, not agent work.
 */
export async function restoreDepot(depot: DepotSnapshot, shadowsRoot: string): Promise<void> {
  const shadowDir = join(shadowsRoot, "shadow", hash(depot.root));
  await shadowGit(shadowDir, depot.root, ["read-tree", depot.treeId]);
  await shadowGit(shadowDir, depot.root, ["checkout-index", "-a", "-f"]);
  await shadowGit(shadowDir, depot.root, ["clean", "-fd"]).catch(() => {});
}
