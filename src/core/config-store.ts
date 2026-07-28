/** @file Snapshot store for owner-authored config files: promote, fall back, roll back. */

import { createHash } from "node:crypto";
import { readFile, readdir, mkdir, stat, rm, rename, appendFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { writeFileAtomically } from "../utils/atomic-write.ts";
import { log } from "../utils/logger.ts";
import {
  MY_CLAW_DIR,
  CONFIG_PATH,
  parseConfig,
  finalizeConfig,
  loadEnv,
  type MyClawConfig,
} from "./config.ts";

const MAX_GENERATIONS = 20;
const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_REJECTED = 10;
const JOURNAL_MAX_BYTES = 5 * 1024 * 1024;

/** Where the content lives. Mode 0700: `.env` snapshots are secrets. */
export function storeDir(): string {
  return join(MY_CLAW_DIR, "backups");
}

/**
 * Artifact id is the path itself, relative to MY_CLAW_DIR when it lives there. No id scheme and no
 * registry of kinds: protecting one more file is one more call site, not a new entry in a table.
 */
export function artifactId(absPath: string): string {
  const rel = relative(MY_CLAW_DIR, absPath);
  const base = rel.startsWith("..") ? absPath.replace(/^[/\\]+/, "") : rel;
  return base.split(sep).join("_").replace(/[^A-Za-z0-9._-]/g, "_");
}

function artifactDir(absPath: string): string {
  return join(storeDir(), artifactId(absPath));
}

/** How long a boot or a reload has to survive before its content is trusted as a fallback. */
export const HEALTH_GATE_MS = 60_000;

export type SnapshotOrigin = "boot" | "reload" | "tool" | "pre-write" | "pre-rollback";

export interface SnapshotMeta {
  origin: SnapshotOrigin;
  changed?: string[];
  rebootRequired?: string[];
  actor?: string;
  note?: string;
}

export interface SnapshotEntry {
  /** Snapshot file name, and the ref accepted by the commands: `<date>-<time>-<sha12>`. */
  ref: string;
  ts: number;
  sha: string;
  size: number;
  /** True when this is the snapshot the health gate confirmed. */
  confirmed: boolean;
}

export function contentSha(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 12);
}
const sha12 = contentSha;

/**
 * A/B state for config.json. Three tiny files rather than one, because they have different
 * lifetimes: strikes are per-content and short-lived, quarantine is a single active verdict, and
 * the confirmed list is history that must outlive both.
 */
const MAX_CONFIRMED_HISTORY = 50;

function statePath(name: string): string {
  return join(storeDir(), name);
}

async function readJson<T>(path: string): Promise<T | null> {
  return readFile(path, "utf-8").then(
    (raw) => JSON.parse(raw) as T,
    () => null,
  );
}

export interface Quarantine {
  sha: string;
  ts: number;
  reason: string;
}

export async function readQuarantine(): Promise<Quarantine | null> {
  return readJson<Quarantine>(statePath("quarantine.json"));
}

export async function setQuarantine(sha: string, reason: string): Promise<void> {
  await mkdir(storeDir(), { recursive: true, mode: 0o700 });
  await writeFileAtomically(statePath("quarantine.json"), JSON.stringify({ sha, ts: Date.now(), reason }), { mode: 0o600 });
  await journal("quarantine", artifactId(CONFIG_PATH), { sha, reason });
}

export async function clearQuarantine(): Promise<void> {
  await rm(statePath("quarantine.json"), { force: true }).catch(() => {});
}

/** Consecutive unhealthy verdicts for one content. Reset the moment the content changes. */
export async function bumpStrike(sha: string): Promise<number> {
  const cur = await readJson<{ sha: string; count: number }>(statePath("strikes.json"));
  const count = cur && cur.sha === sha ? cur.count + 1 : 1;
  await mkdir(storeDir(), { recursive: true, mode: 0o700 });
  await writeFileAtomically(statePath("strikes.json"), JSON.stringify({ sha, count }), { mode: 0o600 });
  return count;
}

export async function clearStrikes(): Promise<void> {
  await rm(statePath("strikes.json"), { force: true }).catch(() => {});
}

/**
 * Every content that was healthy at least once. The A/B loop refuses to quarantine one of these:
 * a config that worked before and fails now points at the environment, not at the config, and
 * reverting would discard the owner's later edits for nothing.
 */
export async function recordConfirmedSha(sha: string): Promise<void> {
  const path = statePath("confirmed-shas");
  const prev = await readFile(path, "utf-8").catch(() => "");
  const list = prev.split("\n").filter(Boolean);
  if (list.includes(sha)) return;
  list.push(sha);
  await mkdir(storeDir(), { recursive: true, mode: 0o700 });
  await writeFileAtomically(path, `${list.slice(-MAX_CONFIRMED_HISTORY).join("\n")}\n`, { mode: 0o600 });
}

export async function hasEverBeenConfirmed(sha: string): Promise<boolean> {
  const raw = await readFile(statePath("confirmed-shas"), "utf-8").catch(() => "");
  return raw.split("\n").includes(sha);
}

/** Sorts lexicographically, which is why the directory needs no index to order its history. */
function stamp(date = new Date()): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, "0");
  return (
    `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}` +
    `-${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}${p(date.getUTCMilliseconds(), 3)}`
  );
}

const REF_RE = /^(\d{8})-(\d{9})-([0-9a-f]{12})$/;

function refToTs(ref: string): number {
  const m = REF_RE.exec(ref);
  if (!m) return 0;
  const d = m[1] as string;
  const t = m[2] as string;
  return Date.UTC(
    Number(d.slice(0, 4)),
    Number(d.slice(4, 6)) - 1,
    Number(d.slice(6, 8)),
    Number(t.slice(0, 2)),
    Number(t.slice(2, 4)),
    Number(t.slice(4, 6)),
    Number(t.slice(6, 9)),
  );
}

/**
 * Append-only, one line per event. Exists for debugging, not for restoring: the directory answers
 * "which versions do I have", this answers "what happened at 18:33, and what caused it". A torn
 * last line costs one event, not the file.
 */
export async function journal(
  event: string,
  artifact: string,
  fields: Record<string, unknown> = {},
): Promise<void> {
  try {
    await mkdir(storeDir(), { recursive: true, mode: 0o700 });
    const path = join(storeDir(), "journal.jsonl");
    const size = await stat(path).then((s) => s.size, () => 0);
    if (size > JOURNAL_MAX_BYTES) await rename(path, `${path}.1`).catch(() => {});
    await appendFile(path, `${JSON.stringify({ ts: Date.now(), event, artifact, ...fields })}\n`, { mode: 0o600 });
  } catch {
    // An aid, not a guarantee: failing to journal must never break a config operation.
  }
}

export async function history(absPath: string): Promise<SnapshotEntry[]> {
  const dir = artifactDir(absPath);
  const names = await readdir(dir).then(
    (n) => n.filter((x) => REF_RE.test(x)).sort(),
    () => [] as string[],
  );
  const confirmed = await confirmedRef(absPath);
  return Promise.all(
    names.map(async (ref) => ({
      ref,
      ts: refToTs(ref),
      sha: ref.slice(-12),
      size: await stat(join(dir, ref)).then((s) => s.size, () => 0),
      confirmed: ref === confirmed,
    })),
  );
}

/**
 * True when this file already has snapshots. Used by generic writers (the `write` tool) to snapshot
 * before overwriting something protected, without needing a second list of paths to match against:
 * the boot pass already created a directory for everything worth keeping.
 */
export async function isTracked(absPath: string): Promise<boolean> {
  return stat(artifactDir(absPath)).then((s) => s.isDirectory(), () => false);
}

export async function readSnapshot(absPath: string, ref: string): Promise<string | null> {
  if (!REF_RE.test(ref)) return null;
  return readFile(join(artifactDir(absPath), ref), "utf-8").catch(() => null);
}

/**
 * A one-line file rather than a symlink: written through the same atomic tmp+rename, portable, and
 * readable with `cat`. A symlink would only have looked nicer in `ls -l`.
 */
async function confirmedRef(absPath: string): Promise<string | null> {
  const raw = await readFile(join(artifactDir(absPath), "confirmed"), "utf-8").catch(() => null);
  const ref = raw?.trim() ?? "";
  return REF_RE.test(ref) ? ref : null;
}

/**
 * Snapshot the current bytes of `absPath`. Deduped by content hash against the newest snapshot, so
 * a promote is silent when nothing changed and a pre-write collapses into nothing when the content
 * is already stored. Returns the ref, or null when the file could not be read.
 */
export async function snapshot(absPath: string, meta: SnapshotMeta): Promise<string | null> {
  let content: string;
  let mode: number;
  try {
    content = await readFile(absPath, "utf-8");
    mode = await stat(absPath).then((s) => s.mode & 0o777);
  } catch {
    return null;
  }
  const sha = sha12(content);
  const newest = (await history(absPath)).at(-1);
  if (newest && newest.sha === sha) return newest.ref;

  const ref = `${stamp()}-${sha}`;
  const dir = artifactDir(absPath);
  // Never rejects: several callers are advisory and fire-and-forget (the prompt loader on an mtime
  // change, the skills loader on a reload), so a store failure must degrade to "no snapshot" with a
  // log line rather than become an unhandled rejection that index.ts turns into an exit.
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFileAtomically(join(dir, ref), content, { mode });
  } catch (err) {
    void log("warn", "config snapshot failed", { path: absPath, error: String(err) });
    return null;
  }
  await journal("snapshot", artifactId(absPath), { ref, ...meta });
  await purge(absPath).catch(() => 0);
  return ref;
}

/**
 * Mark the newest snapshot as the one that proved it runs. Only the health gate calls this: a
 * snapshot taken before an overwrite captures whatever happened to be on disk, which is not the
 * same claim, and must never become the automatic boot fallback.
 */
export async function confirm(absPath: string): Promise<string | null> {
  const newest = (await history(absPath)).at(-1);
  if (!newest || newest.confirmed) return newest?.ref ?? null;
  try {
    await writeFileAtomically(join(artifactDir(absPath), "confirmed"), `${newest.ref}\n`, { mode: 0o600 });
  } catch {
    return null;
  }
  await journal("confirm", artifactId(absPath), { ref: newest.ref });
  return newest.ref;
}

/** Content of the last snapshot that proved it runs, or null when nothing is confirmed yet. */
export async function latestConfirmed(absPath: string): Promise<{ ref: string; content: string } | null> {
  const ref = await confirmedRef(absPath);
  if (!ref) return null;
  const content = await readSnapshot(absPath, ref);
  return content === null ? null : { ref, content };
}

/** Archive content that failed to parse, so repairing the file does not erase the evidence. */
export async function reject(absPath: string, content: string, error: string): Promise<string | null> {
  const sha = sha12(content);
  const dir = join(artifactDir(absPath), "rejected");
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => REF_RE.test(n)).sort();
    if (names.some((n) => n.endsWith(sha))) return null;
    const ref = `${stamp()}-${sha}`;
    await writeFileAtomically(join(dir, ref), content, { mode: 0o600 });
    for (const old of names.slice(0, Math.max(0, names.length + 1 - MAX_REJECTED))) {
      await rm(join(dir, old), { force: true }).catch(() => {});
    }
    await journal("reject", artifactId(absPath), { ref, error });
    return ref;
  } catch {
    return null;
  }
}

/**
 * Drop snapshots past MAX_GENERATIONS or MAX_AGE_MS. The confirmed one is always kept: purging by
 * position alone could leave only pre-write entries and quietly disarm the boot fallback.
 */
export async function purge(absPath: string): Promise<number> {
  const entries = await history(absPath);
  const cutoff = Date.now() - MAX_AGE_MS;
  const doomed = entries.filter(
    (e, i) => !e.confirmed && (i < entries.length - MAX_GENERATIONS || e.ts < cutoff),
  );
  const dir = artifactDir(absPath);
  for (const e of doomed) await rm(join(dir, e.ref), { force: true }).catch(() => {});
  return doomed.length;
}

/**
 * Write a snapshot's content back, archiving what is being overwritten first so the rollback is
 * itself undoable. Callers apply the change themselves: a recreated dotfile emits no fs.watch event
 * at all, so relying on the watcher would apply nothing and report nothing.
 */
export async function restore(
  absPath: string,
  ref: string,
  merge?: (snapshotContent: string, currentContent: string) => string,
): Promise<{ ok: true; bytes: number } | { ok: false; error: string }> {
  const snap = await readSnapshot(absPath, ref);
  if (snap === null) return { ok: false, error: `Snapshot ${ref} introuvable.` };

  await snapshot(absPath, { origin: "pre-rollback", note: `avant restauration de ${ref}` });
  const current = await readFile(absPath, "utf-8").catch(() => "");
  let content: string;
  try {
    content = merge ? merge(snap, current) : snap;
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const mode = await stat(absPath).then((s) => s.mode & 0o777, () => 0o600);
  await writeFileAtomically(absPath, content, { mode });
  await journal("restore", artifactId(absPath), { ref, bytes: content.length });
  return { ok: true, bytes: content.length };
}

/**
 * The files worth protecting: owner-authored, small, and not regenerable. Everything else under
 * MY_CLAW_DIR is either data (sessions, memory.db), a cache (model-catalog.json), protocol state
 * (Matrix/Telegram offsets, whose old copies would desynchronise a channel) or resynced from the
 * repo at boot (skills/.builtin).
 */
export async function protectedPaths(workspaceDir: string): Promise<string[]> {
  const paths = [
    CONFIG_PATH,
    join(MY_CLAW_DIR, ".env"),
    join(MY_CLAW_DIR, "cron", "jobs.json"),
    ...["CORE.md", "SOUL.md", "AGENTS.md", "USER.md"].map((n) => join(workspaceDir, n)),
  ];
  for (const tier of [join(MY_CLAW_DIR, "skills"), join(workspaceDir, "skills")]) {
    const names = await readdir(tier).catch(() => [] as string[]);
    for (const n of names) if (!n.startsWith(".")) paths.push(join(tier, n, "SKILL.md"));
  }
  const toolsDir = join(MY_CLAW_DIR, "tools.d");
  for (const n of await readdir(toolsDir).catch(() => [] as string[])) {
    if (!n.startsWith(".")) paths.push(join(toolsDir, n));
  }
  return paths;
}

/** Snapshot every protected file. Missing files and dedup hits are skipped silently. */
export async function snapshotProtected(workspaceDir: string, meta: SnapshotMeta): Promise<number> {
  const refs = await Promise.all((await protectedPaths(workspaceDir)).map((p) => snapshot(p, meta)));
  return refs.filter((r) => r !== null).length;
}

/**
 * Promote every protected file once the health gate has elapsed. Snapshots first: dedup makes that
 * free when the content is already stored, and it removes the ordering dependency on the boot pass
 * -- otherwise a skipped or failed boot snapshot would leave the gate with nothing to confirm and
 * silently disarm the fallback.
 */
export async function confirmProtected(workspaceDir: string): Promise<number> {
  const paths = await protectedPaths(workspaceDir);
  const refs = await Promise.all(
    paths.map(async (p) => {
      await snapshot(p, { origin: "boot" });
      return confirm(p);
    }),
  );
  return refs.filter((r) => r !== null).length;
}

/**
 * loadConfig, with the crash loop removed. A broken config.json used to throw here and kill the
 * process, which systemd restarts every 5s forever (Restart=always, no StartLimitBurst) leaving the
 * agent unreachable. Falls back to the last confirmed snapshot instead.
 *
 * The broken file is deliberately left exactly as it is: the owner may be mid-edit, and rewriting it
 * would destroy the very thing they need to look at. Every restart re-runs this until it is fixed.
 */
export async function loadConfigOrFallback(): Promise<{
  config: MyClawConfig;
  fallback?: { ref: string; error: string };
}> {
  let firstError: string;
  try {
    const raw = await readConfigRaw();
    // A quarantined content parses fine -- that is the point. It was tried, it left the agent with
    // no reachable channel, and the A/B loop marked it. Editing the file lifts the quarantine by
    // itself, since it is keyed on the content hash.
    const q = await readQuarantine();
    if (q && q.sha === contentSha(raw)) {
      const good = await latestConfirmed(CONFIG_PATH);
      if (good) {
        const config = await finalizeConfig(parseConfig(good.content));
        const error = `config.json en quarantaine (${q.reason})`;
        await journal("fallback", artifactId(CONFIG_PATH), { ref: good.ref, error });
        return { config, fallback: { ref: good.ref, error } };
      }
      // Nothing to land on: run what the owner wrote rather than refusing to start.
      await clearQuarantine();
    }
    return { config: await finalizeConfig(parseConfig(raw)) };
  } catch (err) {
    firstError = err instanceof Error ? err.message : String(err);
  }

  const raw = await readFile(CONFIG_PATH, "utf-8").catch(() => null);
  if (raw !== null) await reject(CONFIG_PATH, raw, firstError);

  const good = await latestConfirmed(CONFIG_PATH);
  if (!good) {
    throw new Error(
      `${firstError}\nAucune sauvegarde confirmee dans ${storeDir()} : repare le fichier a la main.`,
    );
  }
  const config = await finalizeConfig(parseConfig(good.content));
  await journal("fallback", artifactId(CONFIG_PATH), { ref: good.ref, error: firstError });
  return { config, fallback: { ref: good.ref, error: firstError } };
}

async function readConfigRaw(): Promise<string> {
  await mkdir(MY_CLAW_DIR, { recursive: true });
  await loadEnv();
  try {
    return await readFile(CONFIG_PATH, "utf-8");
  } catch {
    throw new Error(
      `Config file not found at ${CONFIG_PATH}\nCopy the template: cp packaging/config.json ~/.my-claw/config.json`,
    );
  }
}
