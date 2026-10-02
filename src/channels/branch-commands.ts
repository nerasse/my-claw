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
import { readMeta, writeMeta, metaOf, type BranchLabel, type ForkOrigin, type UndoState } from "../sessions/meta.ts";
import type { SessionData, SessionAttachment } from "../sessions/store.ts";
import type { SessionManager } from "../sessions/manager.ts";
import { MY_CLAW_DIR } from "../core/config.ts";
import { changesSince, restoreSnapshot, snapshotOfRuns } from "../snapshots/store.ts";
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
  for (let id = log.leaf(); id !== null; ) {
    if (id === expectedLeafId) return true;
    const entry = log.get(id);
    if (!entry || entry.prompt) return false;
    id = entry.parentId;
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

  const path = ctx.log.path();
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

  // The mode is validated before the turn check: a typo is answered wherever the command
  // lands, even on an empty conversation.
  const argTrimmed = args.trim();
  if (argTrimmed && argTrimmed !== "soft" && argTrimmed !== "hard") {
    return { text: "Usage: /undo [soft|hard] — sans argument, choix dans l'app." };
  }

  const path = ctx.log.path();
  const turn = lastTurnOf(path);
  if (!turn) {
    return { text: "Rien à annuler : aucun tour utilisateur." };
  }
  if (turn.type === "compaction") {
    return undoCompaction(ctx, turn);
  }
  const userTurn = turn;

  const preview = userTurn.text.slice(0, 50) + (userTurn.text.length > 50 ? "..." : "");
  let mode: UndoMode = "soft";
  const ask = argTrimmed === "";
  if (argTrimmed === "hard" || argTrimmed === "soft") {
    mode = argTrimmed;
  }

  // The files as they were before this turn: the snapshot of its first run, never the newest of
  // the session, which may belong to another branch or to a turn already undone.
  const turnAt = path.indexOf(userTurn);
  const runIds = path
    .slice(turnAt + 1)
    .filter((entry): entry is RunStartEntry => entry.type === "run_start")
    .map((entry) => entry.runId ?? entry.id);
  const snapshot = await snapshotOfRuns(ctx.sessionId, runIds);
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
    const entries = ctx.log.entries();
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
  const entries = ctx.log.entries();
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
  const path = ctx.log.path();
  if (path.length === 0) {
    return { text: "Impossible de forker une conversation vide." };
  }

  // Determine the fork point
  let forkPointId: string;
  const argTrimmed = args.trim();
  if (argTrimmed) {
    // Fork from a specific entry
    const targetEntry = ctx.log.get(argTrimmed);
    if (!targetEntry) {
      return { text: `Entrée inconnue: ${argTrimmed}` };
    }
    forkPointId = targetEntry.id;
  } else {
    // Fork from current leaf
    forkPointId = ctx.log.leaf()!;
  }

  // Get the path to the fork point
  const forkPath = pathOf(ctx.log.entries(), forkPointId);
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
