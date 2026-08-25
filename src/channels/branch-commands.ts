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
import type { SessionLog, UserEntry, Entry, Provisioned } from "../sessions/log.ts";
import { leavesOf, pathOf, openSessionLog } from "../sessions/log.ts";
import { readMeta, writeMeta, metaOf, type BranchLabel, type ForkOrigin, type UndoState } from "../sessions/meta.ts";
import type { SessionData, SessionAttachment } from "../sessions/store.ts";
import type { SessionManager } from "../sessions/manager.ts";
import { MY_CLAW_DIR } from "../core/config.ts";

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
  /** Abort the current run (for /undo). Returns once the run has settled. */
  abortRun: () => Promise<void>;
  /** Persist the session and its meta. */
  persist: () => Promise<void>;
  /** Generates a sessionId for a new threadId (for fork). */
  resolveNewSessionId: (newThreadId: string) => string;
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
 * Unlike `/retry` and `/branches`, `/undo` aborts a running turn. The reasoning: `/undo`
 * targets the turn that is running, so killing it is part of the ask. `/retry` and `/branches`
 * do not imply that intent — silently discarding work in progress would be a costly surprise.
 */
export async function handleUndoCommand(
  ctx: BranchCommandContext,
  _args: string,
): Promise<BranchCommandResult> {
  // Abort if a run is in progress — this is the key difference with /retry.
  if (ctx.isRunning()) {
    await ctx.abortRun();
  }

  const path = ctx.log.path();
  const userTurn = findNthUserFromEnd(path, 1);
  if (!userTurn) {
    return { text: "Rien à annuler : aucun tour utilisateur." };
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

  const preview = userTurn.text.slice(0, 50) + (userTurn.text.length > 50 ? "..." : "");
  return {
    text: `Undo: conversation rembobinée avant "${preview}". /redo pour revenir.`,
    reset: "branch-switch",
    compose: userTurn.text,
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

  const currentLeaf = ctx.log.leaf() ?? "";
  if (currentLeaf !== meta.undo.expectedLeafId) {
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

  // Append all entries at once with proper chaining
  newLog.appendAll(provisioned);
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
