/**
 * `/branches`, `/retry`, `/fork` — docs/session-log.md §5.
 *
 * Three commands, one invariant: nothing is ever destroyed. A retry moves the cursor, leaving
 * the abandoned turn reachable. A fork copies a path, leaving the source untouched. A branch
 * switch changes what the conversation shows, not what it holds.
 */

import { copyFile, mkdir, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { SessionLog, UserEntry, Entry, Provisioned, CompactionEntry, RunStartEntry } from "../sessions/log.ts";
import { leavesOf, pathOf, openSessionLog } from "../sessions/log.ts";
import { DANGLING_PARENT, NO_PARENT } from "../sessions/log-index.ts";
import { readMeta, writeMeta, metaOf, type BranchLabel, type ForkOrigin, type UndoState } from "../sessions/meta.ts";
import type { SessionData, SessionAttachment } from "../sessions/store.ts";
import type { SessionManager } from "../sessions/manager.ts";
import { MY_CLAW_DIR } from "../core/config.ts";
import { changesSince, MAX_SNAPSHOTS_PER_SESSION, restoreSnapshot, sessionSnapshotRunIds, snapshotOfRuns } from "../snapshots/store.ts";
import type { DepotDiff } from "../snapshots/capture.ts";
import { log } from "../utils/logger.ts";
import { undoManager, type UndoMode } from "./my-claw-app/undo.ts";

/** The outcome of a branch command: what to send back, and what side effects happened. */
export interface BranchCommandResult {
  text: string;
  /** When set, the app must reset the thread (branch switch or retry). */
  reset?: "branch-switch";
  /** Text to prefill in the composer (for retry). */
  compose?: string;
}

/** Context injected by the caller. */
export interface BranchCommandContext {
  sessionManager: SessionManager;
  sessionId: string;
  session: SessionData;
  log: SessionLog;
  /** The owner of this conversation (for fork). */
  owner: string;
  /** The current threadId (for fork). */
  threadId: string;
  /** Whether a run is in progress on this session. */
  isRunning: () => boolean;
  /** Whether a compaction holds the session: it is about to write a boundary at the leaf. */
  isCompacting: () => boolean;
  /** Abort the current run or compaction (for /undo). Returns once it has settled. */
  abortRun: () => Promise<void>;
  /** Persist the session and its meta. */
  persist: () => Promise<void>;
  /** Generates a sessionId for a new threadId (for fork). */
  resolveNewSessionId: (newThreadId: string) => string;
  /** The workspace this conversation runs in. */
  workspaceDir?: string;
  /**
   * When set, `/undo` without an argument asks the owner which mode instead of acting: the app
   * opens a sheet, the handler resolves with the chosen mode, or null when it was dismissed.
   */
  undoPrompt?: (input: {
    sessionId: string;
    owner: string;
    threadId: string;
    diff: DepotDiff[];
    turnPreview: string;
  }) => Promise<UndoMode | null>;
  /**
   * When set, `/undo list` opens the app's turn picker instead of answering in text: the rows are
   * the last turns, each with the mode it allows, and picking one IS the undo.
   *
   * Same shape as `undoPrompt` and for the same reason: the command awaits the choice, so the
   * handler is the channel's, and a surface without one still gets `renderUndoTurns`.
   */
  undoListPrompt?: (input: {
    sessionId: string;
    owner: string;
    threadId: string;
    turns: UndoTurnRow[];
  }) => Promise<{ n: number; mode: UndoMode } | null>;
}

/**
 * Wires the undo prompt for the my-claw-app channel: `/undo` without an argument opens the
 * app's sheet instead of acting. The adapter broadcasts the sheet frame; the owner's
 * `undo.choose` frame resolves it. Returns null when the sheet was dismissed.
 */
export async function askUndoMode(deps: {
  sessionId: string;
  owner: string;
  threadId: string;
  diff: DepotDiff[];
  turnPreview: string;
}): Promise<UndoMode | null> {
  const outcome = await undoManager.prompt({
    sessionId: deps.sessionId,
    owner: deps.owner,
    threadId: deps.threadId,
    diff: deps.diff,
    turnPreview: deps.turnPreview,
  });
  return outcome.kind === "chosen" ? outcome.mode : null;
}

/**
 * Wires the turn picker for the my-claw-app channel: `/undo list` opens it instead of answering.
 *
 * The rows are the server's, the choice is the owner's: picking a row answers `{ n, mode }`, and
 * the command then runs the undo it would have run had the n been typed. A dismissed sheet is
 * `null`, and the command answers nothing -- the list was seen, and nothing was asked of it.
 */
export async function askUndoList(deps: {
  sessionId: string;
  owner: string;
  threadId: string;
  turns: UndoTurnRow[];
}): Promise<{ n: number; mode: UndoMode } | null> {
  const outcome = await undoManager.promptList({
    sessionId: deps.sessionId,
    owner: deps.owner,
    threadId: deps.threadId,
    turns: deps.turns,
  });
  return outcome.kind === "chosen" ? { n: outcome.n, mode: outcome.mode } : null;
}

/**
 * Copies one attachment file to a new thread, returning the new path.
 * If the source file is missing, returns undefined (the entry keeps its old path, which is a dead link).
 */
async function copyAttachment(
  sourcePath: string,
  owner: string,
  newThreadId: string,
): Promise<string | undefined> {
  try {
    await stat(sourcePath);
  } catch {
    // Source file missing: the fork continues, the entry keeps its path, the attachment is a dead link.
    // This matches the source session's state: if a file was deleted there, it is also missing here.
    return undefined;
  }

  const sourceFilename = basename(sourcePath);
  // Extract the original filename after the uuid__ prefix, or use the whole name
  const uuidMatch = /^[0-9a-f-]{36}__(.+)$/i.exec(sourceFilename);
  const originalName = uuidMatch ? uuidMatch[1]! : sourceFilename;

  const newId = randomUUID();
  const newStoredName = `${newId}__${originalName}`;
  const targetDir = join(MY_CLAW_DIR, "files", "my-claw-app", owner, newThreadId);
  const targetPath = join(targetDir, newStoredName);

  await mkdir(targetDir, { recursive: true });
  await copyFile(sourcePath, targetPath);
  return targetPath;
}

/**
 * Copies all attachments from entries to a new thread, mutating the entries in place.
 * Returns the count of successfully copied files.
 */
async function copyAttachmentsForEntries(
  entries: Entry[],
  owner: string,
  newThreadId: string,
): Promise<number> {
  let copied = 0;
  for (const entry of entries) {
    if (entry.type === "user" && (entry as UserEntry).attachments) {
      const userEntry = entry as UserEntry;
      const newAttachments: SessionAttachment[] = [];
      for (const att of userEntry.attachments!) {
        const newPath = await copyAttachment(att.path, owner, newThreadId);
        if (newPath) {
          newAttachments.push({ ...att, path: newPath });
          copied++;
        } else {
          // Keep the original attachment with its dead path
          newAttachments.push(att);
        }
      }
      userEntry.attachments = newAttachments;
    }
  }
  return copied;
}

/** Finds the nth user turn from the end of the current path. */
function findNthUserFromEnd(path: readonly Entry[], n: number): UserEntry | undefined {
  let count = 0;
  for (let i = path.length - 1; i >= 0; i--) {
    const entry = path[i]!;
    if (entry.type === "user") {
      count++;
      if (count === n) return entry as UserEntry;
    }
  }
  return undefined;
}

/** How many turns `/undo list` shows when nothing is asked: enough to place yourself, not a feed. */
export const UNDO_LIST_DEFAULT = 10;
/** The list is bounded: a 588-turn conversation is not a list, and nothing scrolls that far. */
export const UNDO_LIST_MAX = 100;

/** One row of `/undo list`: a user turn, and what an undo to it would actually do. */
export interface UndoTurnRow {
  /** 1 = the last message, the value to pass to `/undo n`. */
  n: number;
  /** The owner's words, clipped for the sheet. Never the whole message: a list of 588 is not a feed. */
  preview: string;
  /** When it was sent, epoch ms. */
  ts: number;
  /** Attachments, voice notes and stems, counted so the row can say what it holds. */
  attachments: number;
  transcripts: number;
  /**
   * Whether a file snapshot still exists for this turn's runs.
   *
   * Not "whether an undo is possible": the conversation can always be rewound. This says whether
   * the *files* can come back too, and it is false for most of an old conversation -- a session
   * keeps the twenty most recent snapshots (docs/session-log.md §7), so the hard mode reaches a
   * handful of turns back and no further.
   */
  hard: boolean;
  /** The turn a compaction closed, rather than a message: it can only be undone softly. */
  compaction?: boolean;
}

/**
 * The last `limit` user turns of a conversation, with the undo depth each one allows.
 *
 * Built from the path, never from the whole log: a branch holds what the conversation is, and a
 * sibling branch's turns are not messages the owner can undo his way out of. The hard flag is
 * computed per turn from the session's snapshot directory, in one read rather than one per turn.
 */
export async function listUndoTurns(
  ctx: { sessionId: string; log: SessionLog },
  limit: number,
): Promise<UndoTurnRow[]> {
  const path = await ctx.log.path();
  const available = await sessionSnapshotRunIds(ctx.sessionId);
  const rows: UndoTurnRow[] = [];
  for (let i = path.length - 1; i >= 0 && rows.length < limit; i--) {
    const entry = path[i]!;
    // A compaction that closes the branch is a turn like a message: undoing takes it back alone.
    if (entry.type === "compaction") {
      rows.push({
        n: rows.length + 1,
        preview: `Compaction (${entry.count} tours repliés)`,
        ts: entry.ts,
        attachments: 0,
        transcripts: 0,
        hard: false,
        compaction: true,
      });
      continue;
    }
    if (entry.type !== "user") continue;
    // The runs between this turn and the next one, which are the ones its snapshot belongs to.
    const runs: string[] = [];
    for (let j = i + 1; j < path.length; j++) {
      const next = path[j]!;
      if (next.type === "user" || next.type === "compaction") break;
      if (next.type === "run_start") runs.push(next.runId ?? next.id);
    }
    rows.push({
      n: rows.length + 1,
      preview: previewOf(entry),
      ts: entry.ts,
      attachments: entry.attachments?.length ?? 0,
      transcripts: entry.transcripts ? Object.keys(entry.transcripts).length : 0,
      hard: runs.some((runId) => available.has(runId)),
    });
  }
  return rows;
}

/**
 * One line per turn, for a surface that can only carry text.
 *
 * The sheet is the normal surface; this is what a channel without one answers with, and what a
 * log or a test reads. The preview is clipped here too: a row exists to be recognised, not read.
 */
export function renderUndoTurns(rows: readonly UndoTurnRow[], now = Date.now()): string {
  if (rows.length === 0) return "Rien à annuler : aucun tour utilisateur.";
  const lines = rows.map((row) => {
    const when = formatAgo(now - row.ts);
    const mode = row.compaction ? "soft" : row.hard ? "hard" : "soft";
    const holds = [
      row.attachments > 0 ? `${row.attachments} fichier${row.attachments > 1 ? "s" : ""}` : "",
      row.transcripts > 0 ? `${row.transcripts} vocal${row.transcripts > 1 ? "s" : ""}` : "",
    ].filter(Boolean).join(", ");
    return `#${row.n}  ${when}  [${mode}]  ${row.preview}${holds ? ` (${holds})` : ""}`;
  });
  return [
    ...lines,
    "",
    "/undo <n> [soft|hard] pour rembobiner avant ce tour.",
    "hard = conversation + fichiers, seulement où un snapshot existe encore.",
  ].join("\n");
}

/** A message as a row shows it: one line, clipped, never the whole body. */
function previewOf(entry: UserEntry): string {
  const flat = entry.text.replace(/\s+/g, " ").trim();
  if (flat.length <= 72) return flat || "(vide)";
  return `${flat.slice(0, 72)}…`;
}

/** "5 min", "2 h", "3 j": a distance the owner can place without arithmetic. */
function formatAgo(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 1) return "à l'instant";
  if (min < 60) return `${min} min`;
  const hours = Math.round(min / 60);
  if (hours < 24) return `${hours} h`;
  return `${Math.round(hours / 24)} j`;
}

/**
 * The last thing that happened to the conversation, as `/undo` sees it.
 *
 * A compaction is a turn like a message is: the owner asked for it (or the gate did) and it
 * changed what the model reads. When it is the last thing on the branch, undoing takes it back
 * and nothing else. Only a compaction that closes the branch counts: one written inside a run,
 * between two iterations, belongs to the message that run answered and goes with that turn.
 * Display-only entries (the `/compact` journal line, a failure notice) sit on top of what they
 * report on and are looked through.
 */
function lastTurnOf(path: readonly Entry[]): UserEntry | CompactionEntry | undefined {
  for (let i = path.length - 1; i >= 0; i--) {
    const entry = path[i]!;
    if (entry.type === "compaction") return entry;
    if (entry.prompt || entry.type === "run_start" || entry.type === "run_end") break;
  }
  return findNthUserFromEnd(path, 1);
}

/**
 * Whether nothing was written since the leaf `/undo` left, walking back from the current one.
 *
 * The app journals every command as a `command` entry at the leaf it left, the `/undo` itself
 * included, so the leaf never is the one the undo recorded. What makes a redo ambiguous is a
 * turn: an entry the model reads (a message, an answer, a boundary). Display-only entries are
 * looked through; anything else on the way, or a leaf on another branch, is a turn written since.
 */
function nothingWrittenSince(log: SessionLog, expectedLeafId: string): boolean {
  let record = log.leaf() === null ? undefined : log.recordOf(log.leaf()!);
  for (let guard = 0; record && guard <= log.count(); guard++) {
    if (record.id === expectedLeafId) return true;
    if (record.prompt) return false;
    record = record.parent === NO_PARENT || record.parent === DANGLING_PARENT ? undefined : log.recordAt(record.parent);
  }
  return expectedLeafId === "";
}

/**
 * `/retry [n]` — recule avant le dernier tour user (ou n tours), remet son texte au composer.
 *
 * The turn is not destroyed: the cursor moves to its parent, leaving the abandoned turn as a
 * sibling branch. That is what makes a retry non-destructive and an undo reversible.
 */
export async function handleRetryCommand(
  ctx: BranchCommandContext,
  args: string,
): Promise<BranchCommandResult> {
  // Refuse while a run is in flight. This differs from `/undo`, which aborts the run first.
  // The reasoning: `/undo` targets the turn that is running, so killing it is part of the ask.
  // `/retry` and `/branches` do not imply that intent — silently discarding work in progress
  // would be a costly surprise. Refusing is reversible (`/stop` then retry); killing is not.
  if (ctx.isRunning()) {
    return { text: "Un run est en cours. Utilise /stop d'abord." };
  }
  // A compaction is about to append its boundary at the leaf: moved now, the leaf is another
  // branch and the boundary would summarize a history that is no longer the one shown.
  if (ctx.isCompacting()) {
    return { text: "Une compaction est en cours. Utilise /stop d'abord." };
  }

  const n = args.trim() ? parseInt(args.trim(), 10) : 1;
  if (isNaN(n) || n < 1) {
    return { text: "Usage: /retry [n] — recule avant le dernier tour user, ou n tours." };
  }

  const path = await ctx.log.path();
  const userTurn = findNthUserFromEnd(path, n);
  if (!userTurn) {
    return { text: n === 1 ? "Aucun tour utilisateur à retenter." : `Pas assez de tours (${n} demandé).` };
  }

  // Move cursor to before this user turn
  ctx.log.branch(userTurn.parentId);
  ctx.session.lastActiveAt = new Date().toISOString();
  await ctx.persist();

  return {
    text: `Retry: conversation rembobinée avant "${userTurn.text.slice(0, 50)}${userTurn.text.length > 50 ? "..." : ""}"`,
    reset: "branch-switch",
    compose: userTurn.text,
  };
}

/**
 * `/undo` — abort the run (if any), rewind before the last user turn, enable `/redo`.
 *
 * Two modes, one command:
 * - `/undo soft` — conversation only (branch the log, restore nothing else). This is the
 *   historical behaviour, and the mode that never touches the disk.
 * - `/undo hard` — conversation plus files: restores the workspace to the snapshot taken at
 *   the start of the run that produced the undone turn (docs/session-log.md §7).
 * - `/undo` (no argument) — asks the owner which mode, via the app's undo sheet, when the
 *   choice means something: at least one file would come back. Otherwise it is a soft undo at
 *   once -- a sheet whose two rows do the same thing is a question with no answer.
 *
 * Unlike `/retry` and `/branches`, `/undo` aborts a running turn in every mode. The reasoning:
 * `/undo` targets the turn that is running, so killing it is part of the ask. `/retry` and
 * `/branches` do not imply that intent — silently discarding work in progress would be a costly
 * surprise.
 */
export async function handleUndoCommand(
  ctx: BranchCommandContext,
  args: string,
): Promise<BranchCommandResult> {
  const tokens = args.trim().split(/\s+/).filter(Boolean);

  // `/undo list [n]`: what there is to undo, before anything is rewound. Answered before the
  // abort below, on purpose -- asking what the turns are must not kill the run that is writing
  // one. The sheet is the normal surface; `renderUndoTurns` is the text a channel without one
  // (and a log, and a test) gets.
  if (tokens[0] === "list") {
    const asked = tokens[1] === undefined ? UNDO_LIST_DEFAULT : Number.parseInt(tokens[1], 10);
    if (!Number.isFinite(asked) || asked < 1) {
      return { text: "Usage: /undo list [n] — n tours, 10 par défaut." };
    }
    const limit = Math.min(asked, UNDO_LIST_MAX);
    const rows = await listUndoTurns(ctx, limit);
    if (ctx.undoListPrompt) {
      const chosen = await ctx.undoListPrompt({
        sessionId: ctx.sessionId,
        owner: ctx.owner,
        threadId: ctx.threadId,
        turns: rows,
      });
      // The sheet is showing the list and the owner picked a row: that IS the undo, n and mode.
      if (chosen) return await undoAtTurn(ctx, chosen.n, chosen.mode);
      // Dismissed with nothing picked: the list was still answered, and it is on screen.
      return { text: "" };
    }
    return { text: renderUndoTurns(rows) };
  }

  // A compaction in flight is the turn in flight: stopping it is the whole undo. It has written
  // nothing yet, so there is nothing to rewind and no /redo to offer.
  if (ctx.isCompacting()) {
    await ctx.abortRun();
    return { text: "Undo: compaction interrompue." };
  }
  // Abort if a run is in progress — this is the key difference with /retry.
  if (ctx.isRunning()) {
    await ctx.abortRun();
  }

  // `/undo [n] [soft|hard]`: n counts back from the last message, exactly like `/retry n`, and
  // the mode is optional. Anything else is a typo, answered wherever the command lands.
  const argv = tokens[0] === "soft" || tokens[0] === "hard" ? ["1", tokens[0]] : tokens;
  const depth = argv[0] === undefined ? 1 : Number.parseInt(argv[0], 10);
  const modeArg = argv[1];
  if (!Number.isFinite(depth) || depth < 1 || (modeArg !== undefined && modeArg !== "soft" && modeArg !== "hard") || argv.length > 2) {
    return { text: "Usage: /undo [n] [soft|hard] — /undo list pour voir les tours." };
  }
  return await undoAtTurn(ctx, depth, modeArg);
}

/**
 * The undo itself: rewind before the `depth`-th turn from the end, in the given mode.
 *
 * Split from the command because the list sheet reaches the same place with an n it read off a
 * row: one implementation of what an undo does, whatever picked the depth.
 */
async function undoAtTurn(
  ctx: BranchCommandContext,
  depth: number,
  modeArg: "soft" | "hard" | undefined,
): Promise<BranchCommandResult> {

  const path = await ctx.log.path();
  // `/undo n` counts user messages back from the end, exactly like `/retry n`. Depth 1 also
  // catches the compaction that closes the branch, which `lastTurnOf` is the only thing that
  // looks for: a deeper undo is about messages, and a compaction in between belongs to the turn
  // it was written for, so it goes with it.
  const turn = depth === 1 ? lastTurnOf(path) : findNthUserFromEnd(path, depth);
  if (!turn) {
    return { text: depth === 1 ? "Rien à annuler : aucun tour utilisateur." : `Pas assez de tours (${depth} demandé).` };
  }
  if (turn.type === "compaction") {
    return undoCompaction(ctx, turn);
  }
  const userTurn = turn;

  const preview = userTurn.text.slice(0, 50) + (userTurn.text.length > 50 ? "..." : "");
  let mode: UndoMode = "soft";
  // A bare `/undo` opens the sheet; a bare `/undo n` does the same, since the mode still has to
  // be picked and the sheet is where the owner sees what it costs. Only an explicit mode skips it.
  const ask = modeArg === undefined;
  if (modeArg !== undefined) {
    mode = modeArg;
  }

  // The files as they were before this turn: the snapshot of its first run, never the newest of
  // the session, which may belong to another branch or to a turn already undone.
  const turnAt = path.indexOf(userTurn);
  const runIds = path
    .slice(turnAt + 1)
    .filter((entry): entry is RunStartEntry => entry.type === "run_start")
    .map((entry) => entry.runId ?? entry.id);
  const snapshot = await snapshotOfRuns(ctx.sessionId, runIds);
  // Asked for the files and there are none to give: refuse rather than silently rewind the
  // conversation alone, which would look like the restore happened. The list already says which
  // turns still reach a snapshot, so this is the deep-undo case the owner was warned about.
  if (modeArg === "hard" && !snapshot) {
    return {
      text: `Pas de snapshot pour le tour #${depth} (les ${MAX_SNAPSHOTS_PER_SESSION} runs les plus récents seulement sont gardés).\n/undo ${depth} soft pour ne rembobiner que la conversation.`,
    };
  }
  // What a hard undo would change: computed before the branch moves, against the files as they
  // are now. Unknown (git could not read the trees) is not "nothing": the owner is asked.
  let diff: DepotDiff[] = [];
  let unknown = false;
  if (snapshot) {
    try {
      diff = (await changesSince(snapshot)).filter((depot) => depot.files > 0);
    } catch (err) {
      unknown = true;
      void log("warn", "undo could not diff the files", { sessionId: ctx.sessionId, error: String(err) });
    }
  }
  const filesWouldChange = diff.length > 0 || unknown;

  // No argument and the app can show a sheet: ask, when there is something to choose between.
  if (ask && ctx.undoPrompt && filesWouldChange) {
    const chosen = await ctx.undoPrompt({
      sessionId: ctx.sessionId,
      owner: ctx.owner,
      threadId: ctx.threadId,
      diff,
      turnPreview: preview,
    });
    if (chosen === null) {
      return { text: "Undo annulé." };
    }
    mode = chosen;
  }

  // Capture the current leaf before moving — this is what /redo will return to.
  const oldLeaf = ctx.log.leaf()!;

  // Move cursor to before this user turn
  ctx.log.branch(userTurn.parentId);
  const newLeaf = ctx.log.leaf(); // May be null if we're at root

  // Save undo state for /redo
  const undoState: UndoState = {
    redoLeafId: oldLeaf,
    expectedLeafId: newLeaf ?? "", // Empty string means root
  };

  // Persist with undo state
  const meta = (await readMeta(ctx.sessionId)) ?? metaOf(ctx.session, newLeaf);
  meta.undo = undoState;
  meta.leafId = newLeaf;
  meta.lastActiveAt = new Date().toISOString();
  ctx.session.lastActiveAt = meta.lastActiveAt;
  await writeMeta(ctx.sessionId, meta);

  // Hard mode: restore the files to the snapshot taken before the turn's first run.
  let filesNote = "";
  if (mode === "hard") {
    if (!snapshot || snapshot.before.depots.length === 0) {
      filesNote = "\nAucun snapshot de fichiers à restaurer (workspace sans dépôt git ou capture impossible).";
    } else {
      try {
        await restoreSnapshot(snapshot);
        filesNote = diff.length > 0
          ? `\nFichiers restaurés (${diff.map((d) => d.root.split("/").pop() || d.root).join(", ")}).`
          : "\nAucune modification de fichier à restaurer.";
      } catch (err) {
        filesNote = `\nRestauration des fichiers échouée: ${String(err)}`;
      }
    }
  }
  // Said only when the sheet was skipped for it: the owner asked a question and got no sheet.
  const quiet = ask && !filesWouldChange ? " (aucun fichier modifié)" : "";

  return {
    text: `Undo: conversation rembobinée avant "${preview}"${quiet}. /redo pour revenir.${filesNote}`,
    reset: "branch-switch",
    compose: userTurn.text,
  };
}

/**
 * Takes a compaction back: the branch resumes right before its boundary, the turns it stood for
 * are the history again. Soft and hard are the same thing here (no run, no files), so the mode
 * is neither asked nor read, and there is no message to hand back to the composer.
 */
async function undoCompaction(ctx: BranchCommandContext, boundary: CompactionEntry): Promise<BranchCommandResult> {
  const oldLeaf = ctx.log.leaf()!;
  ctx.log.branch(boundary.parentId);
  const newLeaf = ctx.log.leaf();

  const meta = (await readMeta(ctx.sessionId)) ?? metaOf(ctx.session, newLeaf);
  meta.undo = { redoLeafId: oldLeaf, expectedLeafId: newLeaf ?? "" };
  meta.leafId = newLeaf;
  meta.lastActiveAt = new Date().toISOString();
  ctx.session.lastActiveAt = meta.lastActiveAt;
  await writeMeta(ctx.sessionId, meta);

  return {
    text: `Undo: compaction annulée, ${boundary.count} tour(s) de nouveau dans le contexte. /redo pour revenir.`,
    reset: "branch-switch",
  };
}

/**
 * `/redo` — return to where we were before `/undo`, if nothing was written in between.
 *
 * See `UndoState` in meta.ts for the full reasoning on why redo refuses after a new turn.
 */
export async function handleRedoCommand(
  ctx: BranchCommandContext,
  _args: string,
): Promise<BranchCommandResult> {
  const meta = await readMeta(ctx.sessionId);
  if (!meta?.undo) {
    return { text: "Rien à refaire : pas de /undo en attente." };
  }

  if (!nothingWrittenSince(ctx.log, meta.undo.expectedLeafId)) {
    // A turn was written since the undo — redo is no longer the immediate inverse.
    // Point the user to /branches with the branch number.
    const entries = await ctx.log.all();
    const leaves = leavesOf(entries);
    const branchNum = leaves.findIndex((l) => l.id === meta.undo!.redoLeafId) + 1;
    const branchHint = branchNum > 0 ? ` (branche ${branchNum} dans /branches)` : "";
    return {
      text: `Redo impossible : la conversation a évolué depuis le /undo. ` +
        `La branche abandonnée est toujours accessible${branchHint}.`,
    };
  }

  // Switch to the redo target
  ctx.log.branch(meta.undo.redoLeafId);

  // Clear undo state — redo is consumed
  delete meta.undo;
  meta.leafId = ctx.log.leaf();
  meta.lastActiveAt = new Date().toISOString();
  ctx.session.lastActiveAt = meta.lastActiveAt;
  await writeMeta(ctx.sessionId, meta);

  return {
    text: "Redo: retour à l'état avant le /undo.",
    reset: "branch-switch",
  };
}

/**
 * `/branches` — list leaves, switch, or name.
 *
 * - `/branches` — list all branches with first user turn and date
 * - `/branches <n>` — switch to branch n
 * - `/branches name <n> <label>` — give branch n a name
 */
export async function handleBranchesCommand(
  ctx: BranchCommandContext,
  args: string,
): Promise<BranchCommandResult> {
  const entries = await ctx.log.all();
  const leaves = leavesOf(entries);
  const currentLeaf = ctx.log.leaf();

  // Load branch labels from meta
  const meta = await readMeta(ctx.sessionId);
  const branchLabels = meta?.branches ?? [];

  // Parse arguments
  const parts = args.trim().split(/\s+/);

  // `/branches name <n> <label>` — name a branch
  if (parts[0] === "name" && parts.length >= 3) {
    const branchNum = parseInt(parts[1]!, 10);
    const label = parts.slice(2).join(" ").trim();

    if (isNaN(branchNum) || branchNum < 1 || branchNum > leaves.length) {
      return { text: `Branche invalide: ${parts[1]}. Il y a ${leaves.length} branche(s).` };
    }
    if (!label) {
      return { text: "Usage: /branches name <n> <label>" };
    }

    const targetLeaf = leaves[branchNum - 1]!;
    
    // Update or add the label
    const existingIdx = branchLabels.findIndex((b) => b.leafId === targetLeaf.id);
    if (existingIdx >= 0) {
      branchLabels[existingIdx] = { leafId: targetLeaf.id, label, ts: Date.now() };
    } else {
      branchLabels.push({ leafId: targetLeaf.id, label, ts: Date.now() });
    }

    // Write back to meta
    if (meta) {
      meta.branches = branchLabels;
      await writeMeta(ctx.sessionId, meta);
    } else {
      // Create meta if it doesn't exist
      const newMeta = metaOf(ctx.session, ctx.log.leaf());
      newMeta.branches = branchLabels;
      await writeMeta(ctx.sessionId, newMeta);
    }

    return { text: `Branche ${branchNum} nommée "${label}".` };
  }

  // `/branches <n>` — switch to branch n
  if (parts[0] && /^\d+$/.test(parts[0])) {
    if (ctx.isRunning()) {
      return { text: "Un run est en cours. Utilise /stop d'abord." };
    }
    if (ctx.isCompacting()) {
      return { text: "Une compaction est en cours. Utilise /stop d'abord." };
    }

    const branchNum = parseInt(parts[0], 10);
    if (branchNum < 1 || branchNum > leaves.length) {
      return { text: `Branche invalide: ${branchNum}. Il y a ${leaves.length} branche(s).` };
    }

    const targetLeaf = leaves[branchNum - 1]!;
    if (targetLeaf.id === currentLeaf) {
      return { text: `Déjà sur la branche ${branchNum}.` };
    }

    ctx.log.branch(targetLeaf.id);
    ctx.session.lastActiveAt = new Date().toISOString();
    await ctx.persist();

    const labelInfo = branchLabels.find((b) => b.leafId === targetLeaf.id);
    const labelStr = labelInfo ? ` ("${labelInfo.label}")` : "";
    return {
      text: `Basculé sur la branche ${branchNum}${labelStr}.`,
      reset: "branch-switch",
    };
  }

  // `/branches` — list all branches
  if (leaves.length === 0) {
    return { text: "Aucune branche (conversation vide)." };
  }

  const lines: string[] = [`${leaves.length} branche(s):`];
  for (let i = 0; i < leaves.length; i++) {
    const leaf = leaves[i]!;
    const path = pathOf(entries, leaf.id);
    const firstUser = path.find((e) => e.type === "user") as UserEntry | undefined;
    const isCurrent = leaf.id === currentLeaf;
    const labelInfo = branchLabels.find((b) => b.leafId === leaf.id);

    let line = `${i + 1}. `;
    if (isCurrent) line += "→ ";
    if (labelInfo) line += `[${labelInfo.label}] `;
    if (firstUser) {
      const preview = firstUser.text.slice(0, 40) + (firstUser.text.length > 40 ? "..." : "");
      line += `"${preview}"`;
    } else {
      line += "(pas de message user)";
    }
    line += ` — ${new Date(leaf.ts).toLocaleString()}`;
    lines.push(line);
  }

  lines.push("");
  lines.push("Utilise /branches <n> pour basculer, /branches name <n> <label> pour nommer.");
  return { text: lines.join("\n") };
}

/** The outcome of a fork command: includes the new threadId for navigation. */
export interface ForkCommandResult extends BranchCommandResult {
  /** The new threadId the app should navigate to. */
  newThreadId?: string;
}

/**
 * `/fork [entryId]` — create a new session with a copy of the path.
 *
 * Creates a new conversation containing the entries from the root to the specified point
 * (or the current leaf if no entryId is given). The source session is unchanged.
 *
 * **Attachment handling:** Entries are copied verbatim, meaning their `attachments` arrays
 * still reference files stored under the source threadId. If the source session is deleted,
 * those files become dead links. This is the "ne pas copier" behavior from docs/session-log.md
 * §5.3. Full attachment copying would require:
 * - Copying files from `files/my-claw-app/<owner>/<sourceThreadId>/` to the new thread
 * - Rewriting the `path` field in each attachment
 * - A UI choice (copy/don't copy) before the fork
 *
 * For now, `forkedFrom.attachments` is set to `"none"` to document this.
 */
export async function handleForkCommand(
  ctx: BranchCommandContext,
  args: string,
): Promise<ForkCommandResult> {
  const path = await ctx.log.path();
  if (path.length === 0) {
    return { text: "Impossible de forker une conversation vide." };
  }

  // Determine the fork point
  let forkPointId: string;
  const argTrimmed = args.trim();
  if (argTrimmed) {
    // Fork from a specific entry
    const target = ctx.log.recordOf(argTrimmed);
    if (!target) {
      return { text: `Entrée inconnue: ${argTrimmed}` };
    }
    forkPointId = target.id;
  } else {
    // Fork from current leaf
    forkPointId = ctx.log.leaf()!;
  }

  // Get the path to the fork point
  const forkPath = pathOf(await ctx.log.all(), forkPointId);
  if (forkPath.length === 0) {
    return { text: "Le point de fork n'est pas dans le chemin courant." };
  }

  // Generate a new threadId and sessionId
  const newThreadId = randomUUID();
  const newSessionId = ctx.resolveNewSessionId(newThreadId);

  // Open a new log for the forked session
  const newLog = await openSessionLog(newSessionId);

  // Deep clone entries so we can mutate attachments without touching the source
  const clonedPath: Entry[] = forkPath.map((entry) => JSON.parse(JSON.stringify(entry)) as Entry);

  // Copy attachment files to the new thread, mutating clonedPath in place
  await copyAttachmentsForEntries(clonedPath, ctx.owner, newThreadId);

  // Prepare entries for appendAll: strip id/seq/parentId/ts, they will be reassigned.
  // The entries are re-chained by appendAll automatically.
  const provisioned: Array<Provisioned & { ts?: number }> = clonedPath.map((entry) => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { id, seq, parentId, ...rest } = entry;
    return rest as Provisioned & { ts?: number };
  });

  // Append all entries at once with proper chaining. The source ids cannot survive the fork because
  // they would point at the source tree; remap every cross-entry compaction reference while the
  // new ids are still in memory, before appendAll writes a single byte.
  newLog.appendAll(provisioned, (written) => {
    const oldToNew = new Map(clonedPath.map((entry, index) => [entry.id, written[index]!.id]));
    for (let index = 0; index < written.length; index++) {
      const source = clonedPath[index]!;
      const target = written[index]!;
      if (source.type !== "compaction" || target.type !== "compaction") continue;
      const mapped = oldToNew.get((source as CompactionEntry).firstKeptEntryId);
      if (mapped) target.firstKeptEntryId = mapped;
    }
  });
  await newLog.flush();

  // Create and persist the new session
  const newSession = await ctx.sessionManager.getOrCreateWithMeta(
    newSessionId,
    "my-claw-app",
    "dm",
    ctx.session.workspace,
  );
  newSession.lastActiveAt = new Date().toISOString();

  // Write meta with forkedFrom
  const forkedFrom: ForkOrigin = {
    sessionId: ctx.sessionId,
    entryId: forkPointId,
  };
  const newMeta = metaOf(newSession, newLog.leaf());
  newMeta.forkedFrom = forkedFrom;
  await writeMeta(newSessionId, newMeta);
  await ctx.sessionManager.persist(newSessionId);

  const entryCount = forkPath.length;
  return {
    text: `Fork créé: ${entryCount} entrée(s) copiée(s) vers une nouvelle conversation.\nNouveau thread: ${newThreadId}`,
    newThreadId,
  };
}
