/**
 * Puts the dead branches of every session log back on the branch, ahead of the open that would do
 * it one session at a time (`src/sessions/branches.ts` has the rules and the why).
 *
 * Dry run by default. `--apply` rewrites `entries.jsonl` where a parent link moved (a
 * `.bak-branches-<time>` copy is kept beside it) and moves `meta.json`'s leaf when a tail was
 * adopted. Run it with the server stopped, or accept that a session the server holds open shows
 * the repair after its next restart: the file is the truth on the next open, the process keeps
 * its own picture until then.
 *
 *   bun run scripts/repair-branches.ts [--apply] [--dir ~/.my-claw] [<session dir> ...]
 */

import { copyFileSync, existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { repairBranches } from "../src/sessions/branches.ts";
import { parseEntryLine, type Entry } from "../src/sessions/log.ts";

interface Report {
  session: string;
  entries: number;
  offPath: number;
  bugForks: number;
  deliberateForks: number;
  adoptedTail: boolean;
  relinked: number;
  reparented: number;
}

// Read through the log's own parser, so a line that carries an entry glued behind a stump gives
// that entry up here too. Reading it any other way would drop the entry and then rewrite the file
// without it, which is the damage this script exists to undo.
function parseLog(file: string, session: string): Entry[] {
  const entries: Entry[] = [];
  const lines = readFileSync(file, "utf-8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const entry = parseEntryLine(lines[i]!, session, i + 1);
    if (entry) entries.push(entry);
  }
  return entries;
}

function offPathCount(entries: readonly Entry[], leafId: string | null): number {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const path = new Set<string>();
  let cur = leafId && byId.has(leafId) ? byId.get(leafId) : entries[entries.length - 1];
  while (cur && !path.has(cur.id)) {
    path.add(cur.id);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return entries.length - path.size;
}

function repair(dir: string, apply: boolean, root: string): Report | null {
  const file = join(dir, "entries.jsonl");
  const metaFile = join(dir, "meta.json");
  if (!existsSync(file)) return null;
  const entries = parseLog(file, relative(root, dir));
  if (entries.length === 0) return null;
  const meta = existsSync(metaFile) ? (JSON.parse(readFileSync(metaFile, "utf-8")) as Record<string, unknown>) : null;
  const leafId = typeof meta?.leafId === "string" ? meta.leafId : null;
  const out = repairBranches(entries, leafId);
  const report: Report = {
    session: relative(root, dir),
    entries: entries.length,
    offPath: offPathCount(entries, leafId),
    bugForks: out.bugForks,
    deliberateForks: out.deliberateForks,
    adoptedTail: out.adoptedTail,
    relinked: out.relinked.length,
    reparented: out.reparented.length,
  };
  if (!apply || (report.relinked === 0 && report.reparented === 0 && !report.adoptedTail)) return report;

  if (report.relinked > 0 || report.reparented > 0) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    copyFileSync(file, `${file}.bak-branches-${stamp}`);
    writeFileSync(`${file}.tmp`, out.entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""), "utf-8");
    renameSync(`${file}.tmp`, file);
  }
  if (report.adoptedTail && meta) {
    writeFileSync(`${metaFile}.tmp`, JSON.stringify({ ...meta, leafId: out.leafId }, null, 2) + "\n", "utf-8");
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
  if (!report || (report.offPath === 0 && report.reparented === 0)) continue;
  const acts = report.relinked > 0 || report.reparented > 0 || report.adoptedTail;
  if (acts) touched += 1;
  const verdict = !acts ? "deliberate only, untouched" : apply ? "repaired" : "would repair";
  console.log(
    `${report.session}: ${report.entries} entries, ${report.offPath} off-path, ${report.bugForks} bug fork(s), ${report.deliberateForks} deliberate, ${report.reparented} orphan(s), ${report.relinked + report.reparented} line(s) ${apply ? "rewritten" : "to rewrite"}${report.adoptedTail ? ", tail adopted as leaf" : ""} -> ${verdict}`,
  );
}
console.log(`${dirs.length} session(s) scanned, ${touched} ${apply ? "repaired" : "would be repaired"}.${apply ? "" : " Dry run: pass --apply to write."}`);
