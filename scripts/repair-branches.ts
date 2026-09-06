/**
 * Puts a session log's dead branches back on its branch.
 *
 * Until 0.6.1 a session could be held by two `SessionLog` instances at once (one per run, one read
 * back off the disk after the cache evicted the first), each with its own leaf. Whatever the second
 * one appended -- a compaction boundary, a failure entry, the owner's next message -- hung off a
 * stale leaf, and everything the run had written past that leaf became a dead branch: still in the
 * file, gone from the thread, gone from the prompt. The same shape is left by a process killed
 * mid-run, since the leaf was only persisted at the end of a run.
 *
 * A dead branch here is not a rewind. A rewind is deliberate and leaves its mark: `/undo`, `/retry`,
 * `/redo` and `/fork` append a `command` entry as the first entry of the new branch, and a run that
 * died of an error rewinds to its own question, so the fork sits on a `user` entry with a
 * `run_start` child whose run ends in `error`. Those are kept as they are. Any other fork is the bug:
 * its orphans are spliced back in file order between the fork point and the surviving child, which
 * is the order they happened in, and a trailing dead tail becomes the branch's new tip.
 *
 * Dry run by default. `--apply` rewrites `entries.jsonl` (a `.bak-branches-<time>` copy is kept
 * beside it) and moves `meta.json`'s leaf when a tail was adopted. Run it with the server stopped,
 * or accept that a session the server holds open shows the repair after its next restart: the file
 * is the truth on the next open, the process keeps its own picture until then.
 *
 *   bun run scripts/repair-branches.ts [--apply] [--dir ~/.my-claw] [<session dir> ...]
 */

import { copyFileSync, existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";

interface LogEntry {
  id: string;
  parentId: string | null;
  seq: number;
  type: string;
  input?: string;
  reason?: string;
}

interface Line {
  raw: string;
  entry: LogEntry;
  changed: boolean;
}

interface Report {
  session: string;
  entries: number;
  offPath: number;
  bugForks: number;
  deliberateForks: number;
  adoptedTail: boolean;
  changed: number;
  note?: string;
}

const BRANCH_COMMANDS = /^\/(undo|retry|redo|fork|branch)\b/i;

function parseLog(file: string): Line[] {
  const lines: Line[] = [];
  for (const raw of readFileSync(file, "utf-8").split("\n")) {
    if (!raw.trim()) continue;
    try {
      const entry = JSON.parse(raw) as LogEntry;
      if (typeof entry.id === "string") lines.push({ raw, entry, changed: false });
    } catch {
      // A torn last line is the log's own business (it skips it on read); it is left alone here.
    }
  }
  return lines;
}

function pathOf(byId: Map<string, LogEntry>, leafId: string): Set<string> {
  const path = new Set<string>();
  let cur: LogEntry | undefined = byId.get(leafId);
  while (cur && !path.has(cur.id)) {
    path.add(cur.id);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return path;
}

/** Whether the chain starting at `head` (following the first child each time) ends in an error run_end. */
function errorRun(head: LogEntry, children: Map<string, LogEntry[]>): boolean {
  if (head.type !== "run_start") return false;
  let cur: LogEntry | undefined = head;
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    if (cur.type === "run_end") return cur.reason === "error";
    cur = children.get(cur.id)?.[0];
  }
  return false;
}

function descendants(root: LogEntry, children: Map<string, LogEntry[]>): LogEntry[] {
  const out: LogEntry[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    out.push(cur);
    for (const child of children.get(cur.id) ?? []) stack.push(child);
  }
  return out;
}

function repair(dir: string, apply: boolean, root: string): Report | null {
  const file = join(dir, "entries.jsonl");
  const metaFile = join(dir, "meta.json");
  if (!existsSync(file)) return null;
  const session = relative(root, dir);
  const lines = parseLog(file);
  if (lines.length === 0) return null;
  const byId = new Map(lines.map((l) => [l.entry.id, l.entry]));
  const byLine = new Map(lines.map((l) => [l.entry.id, l]));
  const children = new Map<string, LogEntry[]>();
  for (const { entry } of lines) {
    if (!entry.parentId) continue;
    const list = children.get(entry.parentId) ?? [];
    list.push(entry);
    children.set(entry.parentId, list);
  }
  for (const list of children.values()) list.sort((a, b) => a.seq - b.seq);

  const meta = existsSync(metaFile) ? (JSON.parse(readFileSync(metaFile, "utf-8")) as { leafId?: string | null }) : {};
  let leafId = meta.leafId && byId.has(meta.leafId) ? meta.leafId : lines[lines.length - 1]!.entry.id;
  let path = pathOf(byId, leafId);
  const offPath = lines.filter((l) => !path.has(l.entry.id)).length;
  const report: Report = { session, entries: lines.length, offPath, bugForks: 0, deliberateForks: 0, adoptedTail: false, changed: 0 };
  if (offPath === 0) return report;

  // Fork points: on-path entries with an off-path child, in branch order (oldest first).
  const forks = new Map<string, LogEntry[]>();
  for (const { entry } of lines) {
    if (path.has(entry.id) || !entry.parentId || !path.has(entry.parentId)) continue;
    const list = forks.get(entry.parentId) ?? [];
    list.push(entry);
    forks.set(entry.parentId, list);
  }
  const orphanRoots = lines.filter((l) => !path.has(l.entry.id) && (!l.entry.parentId || !byId.has(l.entry.parentId)));
  if (orphanRoots.length > 0) report.note = `${orphanRoots.length} off-path entries with no parent in the log, left alone`;

  const ordered = [...forks.entries()].sort(([a], [b]) => byId.get(a)!.seq - byId.get(b)!.seq);
  for (const [forkId, offChildren] of ordered) {
    const fork = byId.get(forkId)!;
    const survivor = (children.get(forkId) ?? []).find((c) => path.has(c.id));
    const deliberate =
      (survivor?.type === "command" && BRANCH_COMMANDS.test(survivor.input ?? "")) ||
      (fork.type === "user" && offChildren.some((c) => errorRun(c, children)));
    if (deliberate) {
      report.deliberateForks += 1;
      continue;
    }
    report.bugForks += 1;
    const orphans = offChildren.flatMap((child) => descendants(child, children)).sort((a, b) => a.seq - b.seq);
    let prev = fork.id;
    for (const orphan of orphans) {
      if (orphan.parentId !== prev) {
        orphan.parentId = prev;
        byLine.get(orphan.id)!.changed = true;
      }
      prev = orphan.id;
    }
    if (survivor) {
      survivor.parentId = prev;
      byLine.get(survivor.id)!.changed = true;
    } else {
      leafId = prev;
      report.adoptedTail = true;
    }
    // The splice moved the path: what follows must see the fork's orphans as on-path now.
    path = pathOf(byId, leafId);
  }

  report.changed = lines.filter((l) => l.changed).length;
  if (!apply || (report.changed === 0 && !report.adoptedTail)) return report;

  if (report.changed > 0) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    copyFileSync(file, `${file}.bak-branches-${stamp}`);
    const out = lines.map((l) => (l.changed ? JSON.stringify(l.entry) : l.raw)).join("\n") + "\n";
    writeFileSync(`${file}.tmp`, out, "utf-8");
    renameSync(`${file}.tmp`, file);
  }
  if (report.adoptedTail && existsSync(metaFile)) {
    const full = JSON.parse(readFileSync(metaFile, "utf-8")) as Record<string, unknown>;
    full.leafId = leafId;
    writeFileSync(`${metaFile}.tmp`, JSON.stringify(full, null, 2) + "\n", "utf-8");
    renameSync(`${metaFile}.tmp`, metaFile);
  }
  return report;
}

function sessionDirs(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (!statSync(full).isDirectory()) continue;
      if (existsSync(join(full, "entries.jsonl"))) out.push(full);
      else walk(full);
    }
  };
  walk(root);
  return out.sort();
}

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const dirFlag = args.indexOf("--dir");
const clawDir = dirFlag >= 0 ? args[dirFlag + 1]! : process.env.MY_CLAW_DIR ?? join(homedir(), ".my-claw");
const root = join(clawDir, "sessions");
const explicit = args.filter((a, i) => !a.startsWith("--") && (dirFlag < 0 || i !== dirFlag + 1));
const dirs = explicit.length > 0 ? explicit : sessionDirs(root);

let touched = 0;
for (const dir of dirs) {
  const report = repair(dir, apply, root);
  if (!report || report.offPath === 0) continue;
  touched += report.changed > 0 || report.adoptedTail ? 1 : 0;
  const verdict = report.bugForks === 0 ? "deliberate only, untouched" : apply ? "repaired" : "would repair";
  console.log(
    `${report.session}: ${report.entries} entries, ${report.offPath} off-path, ${report.bugForks} bug fork(s), ${report.deliberateForks} deliberate, ${report.changed} line(s) ${apply ? "rewritten" : "to rewrite"}${report.adoptedTail ? ", tail adopted as leaf" : ""} -> ${verdict}${report.note ? ` (${report.note})` : ""}`,
  );
}
console.log(`${dirs.length} session(s) scanned, ${touched} ${apply ? "repaired" : "would be repaired"}.${apply ? "" : " Dry run: pass --apply to write."}`);
