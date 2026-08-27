import { describe, test, expect, afterEach } from "bun:test";
import { mkdir, rm, writeFile, stat, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  handleRetryCommand,
  handleBranchesCommand,
  handleForkCommand,
  handleUndoCommand,
  handleRedoCommand,
  type BranchCommandContext,
} from "../../src/channels/branch-commands.ts";
import {
  openSessionLog,
  pathOf,
  type SessionLog,
  type UserEntry,
  type PhaseEntry,
  type CompactionEntry,
} from "../../src/sessions/log.ts";
import { contextEntries } from "../../src/sessions/projection.ts";
import { readMeta, writeMeta, metaOf } from "../../src/sessions/meta.ts";
import type { LegacySessionData, SessionAttachment } from "../../src/sessions/store.ts";
import { SessionManager } from "../../src/sessions/manager.ts";
import { MY_CLAW_DIR } from "../../src/core/config.ts";

let counter = 0;
function freshId(): string {
  return `test-branch-${process.pid}-${counter++}`;
}

function createMockSession(sessionId: string): LegacySessionData {
  return {
    id: sessionId,
    platform: "my-claw-app",
    chatType: "dm",
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    messages: [],
  };
}

const testOwner = "test-owner";

interface CreateContextOptions {
  isRunning?: boolean;
  sessionManager?: SessionManager;
  onAbort?: () => void;
}

async function createContext(
  sessionId: string,
  log: SessionLog,
  options: CreateContextOptions | boolean = {},
): Promise<BranchCommandContext> {
  // Backward compat: if a boolean is passed, it's `isRunning`
  const opts = typeof options === "boolean" ? { isRunning: options } : options;
  const { isRunning = false, sessionManager, onAbort } = opts;

  const session = createMockSession(sessionId);
  const manager = sessionManager ?? new SessionManager();
  // Extract threadId from sessionId (format: my-claw-app/thread/<owner>/<threadId>)
  const threadId = sessionId.split("/").pop() ?? sessionId;
  return {
    sessionManager: manager,
    sessionId,
    session,
    log,
    owner: testOwner,
    threadId,
    isRunning: () => isRunning,
    abortRun: async () => {
      onAbort?.();
    },
    persist: async () => {
      // Read existing meta to preserve fields like `undo`, then update leaf
      const existing = await readMeta(sessionId);
      const meta = existing ?? metaOf(session, log.leaf());
      meta.leafId = log.leaf();
      meta.lastActiveAt = new Date().toISOString();
      await writeMeta(sessionId, meta);
    },
    resolveNewSessionId: (newThreadId: string) =>
      SessionManager.resolveSessionId("my-claw-app", "dm", testOwner, testOwner, { threadId: newThreadId }),
  };
}

describe("branch-commands: /retry", () => {
  test("retry with no user turns returns an error", async () => {
    const id = freshId();
    const log = await openSessionLog(id);
    const ctx = await createContext(id, log);

    const result = await handleRetryCommand(ctx, "");
    expect(result.text).toContain("Aucun tour utilisateur");
    expect(result.reset).toBeUndefined();
  });

  test("retry moves cursor before the last user turn and returns the text", async () => {
    const id = freshId();
    const log = await openSessionLog(id);
    const user1 = log.append<UserEntry>({ type: "user", prompt: true, text: "Question 1" });
    log.append<PhaseEntry>({ type: "phase", prompt: true, text: "Réponse 1", runId: "r1" });
    const user2 = log.append<UserEntry>({ type: "user", prompt: true, text: "Question 2" });
    log.append<PhaseEntry>({ type: "phase", prompt: true, text: "Réponse 2", runId: "r2" });
    await log.flush();

    const ctx = await createContext(id, log);
    const result = await handleRetryCommand(ctx, "");

    expect(result.reset).toBe("branch-switch");
    expect(result.compose).toBe("Question 2");
    expect(log.leaf()).toBe(user2.parentId);
  });

  test("retry 2 moves cursor before the second-to-last user turn", async () => {
    const id = freshId();
    const log = await openSessionLog(id);
    log.append<UserEntry>({ type: "user", prompt: true, text: "Question 1" });
    log.append<PhaseEntry>({ type: "phase", prompt: true, text: "Réponse 1", runId: "r1" });
    log.append<UserEntry>({ type: "user", prompt: true, text: "Question 2" });
    log.append<PhaseEntry>({ type: "phase", prompt: true, text: "Réponse 2", runId: "r2" });
    await log.flush();

    const ctx = await createContext(id, log);
    const result = await handleRetryCommand(ctx, "2");

    expect(result.reset).toBe("branch-switch");
    expect(result.compose).toBe("Question 1");
  });

  test("retry refuses while a run is in progress", async () => {
    const id = freshId();
    const log = await openSessionLog(id);
    log.append<UserEntry>({ type: "user", prompt: true, text: "Question" });
    await log.flush();

    const ctx = await createContext(id, log, true);
    const result = await handleRetryCommand(ctx, "");

    expect(result.text).toContain("run est en cours");
    expect(result.reset).toBeUndefined();
  });

  test("retry with invalid n returns usage", async () => {
    const id = freshId();
    const log = await openSessionLog(id);
    const ctx = await createContext(id, log);

    const result = await handleRetryCommand(ctx, "abc");
    expect(result.text).toContain("Usage");
  });
});

describe("branch-commands: /branches", () => {
  test("branches on empty log returns empty message", async () => {
    const id = freshId();
    const log = await openSessionLog(id);
    const ctx = await createContext(id, log);

    const result = await handleBranchesCommand(ctx, "");
    expect(result.text).toContain("Aucune branche");
  });

  test("branches lists all leaves with first user text", async () => {
    const id = freshId();
    const log = await openSessionLog(id);
    const user1 = log.append<UserEntry>({ type: "user", prompt: true, text: "Première question" });
    log.append<PhaseEntry>({ type: "phase", prompt: true, text: "Réponse 1", runId: "r1" });
    // Create a branch by moving back and appending
    log.branch(user1.id);
    log.append<PhaseEntry>({ type: "phase", prompt: true, text: "Réponse alternative", runId: "r2" });
    await log.flush();

    const ctx = await createContext(id, log);
    const result = await handleBranchesCommand(ctx, "");

    expect(result.text).toContain("2 branche(s)");
    expect(result.text).toContain("Première question");
  });

  test("branches <n> switches to the specified branch", async () => {
    const id = freshId();
    const log = await openSessionLog(id);
    const user1 = log.append<UserEntry>({ type: "user", prompt: true, text: "Question" });
    const phase1 = log.append<PhaseEntry>({ type: "phase", prompt: true, text: "Réponse 1", runId: "r1" });
    log.branch(user1.id);
    const phase2 = log.append<PhaseEntry>({ type: "phase", prompt: true, text: "Réponse 2", runId: "r2" });
    await log.flush();

    // Currently on the second branch (phase2)
    expect(log.leaf()).toBe(phase2.id);

    const ctx = await createContext(id, log);
    const result = await handleBranchesCommand(ctx, "1");

    expect(result.reset).toBe("branch-switch");
    expect(log.leaf()).toBe(phase1.id);
  });

  test("branches <n> refuses while a run is in progress", async () => {
    const id = freshId();
    const log = await openSessionLog(id);
    log.append<UserEntry>({ type: "user", prompt: true, text: "Question" });
    await log.flush();

    const ctx = await createContext(id, log, true);
    const result = await handleBranchesCommand(ctx, "1");

    expect(result.text).toContain("run est en cours");
    expect(result.reset).toBeUndefined();
  });

  test("branches name <n> <label> sets a branch label", async () => {
    const id = freshId();
    const log = await openSessionLog(id);
    log.append<UserEntry>({ type: "user", prompt: true, text: "Question" });
    log.append<PhaseEntry>({ type: "phase", prompt: true, text: "Réponse", runId: "r1" });
    await log.flush();

    const ctx = await createContext(id, log);
    const result = await handleBranchesCommand(ctx, "name 1 Ma branche");

    expect(result.text).toContain('nommée "Ma branche"');

    // Check meta was updated
    const meta = await readMeta(id);
    expect(meta?.branches).toHaveLength(1);
    expect(meta?.branches?.[0]?.label).toBe("Ma branche");
  });

  test("branches shows current branch with arrow", async () => {
    const id = freshId();
    const log = await openSessionLog(id);
    log.append<UserEntry>({ type: "user", prompt: true, text: "Question" });
    log.append<PhaseEntry>({ type: "phase", prompt: true, text: "Réponse", runId: "r1" });
    await log.flush();

    const ctx = await createContext(id, log);
    const result = await handleBranchesCommand(ctx, "");

    expect(result.text).toContain("→");
  });

  test("branches with invalid number returns error", async () => {
    const id = freshId();
    const log = await openSessionLog(id);
    log.append<UserEntry>({ type: "user", prompt: true, text: "Question" });
    await log.flush();

    const ctx = await createContext(id, log);
    const result = await handleBranchesCommand(ctx, "99");

    expect(result.text).toContain("invalide");
  });
});

describe("branch-commands: /fork", () => {
  test("fork on empty conversation returns error", async () => {
    const id = freshId();
    const log = await openSessionLog(id);
    const ctx = await createContext(id, log);

    const result = await handleForkCommand(ctx, "");
    expect(result.text).toContain("vide");
    expect(result.newThreadId).toBeUndefined();
  });

  test("fork creates a new session with copied entries", async () => {
    const id = freshId();
    const log = await openSessionLog(id);
    log.append<UserEntry>({ type: "user", prompt: true, text: "Question 1" });
    log.append<PhaseEntry>({ type: "phase", prompt: true, text: "Réponse 1", runId: "r1" });
    log.append<UserEntry>({ type: "user", prompt: true, text: "Question 2" });
    log.append<PhaseEntry>({ type: "phase", prompt: true, text: "Réponse 2", runId: "r2" });
    await log.flush();

    const manager = new SessionManager();
    const ctx = await createContext(id, log, { sessionManager: manager });
    const result = await handleForkCommand(ctx, "");

    expect(result.text).toContain("4 entrée(s) copiée(s)");
    expect(result.newThreadId).toBeDefined();

    // Verify the new session was created with the correct entries
    const newSessionId = ctx.resolveNewSessionId(result.newThreadId!);
    const newLog = await openSessionLog(newSessionId);
    expect(newLog.entries()).toHaveLength(4);

    // Verify entries are properly chained (parentIds form a linked list)
    const newEntries = newLog.entries();
    expect(newEntries[0]!.parentId).toBeNull();
    expect(newEntries[1]!.parentId).toBe(newEntries[0]!.id);
    expect(newEntries[2]!.parentId).toBe(newEntries[1]!.id);
    expect(newEntries[3]!.parentId).toBe(newEntries[2]!.id);

    // Verify content is preserved
    expect((newEntries[0] as UserEntry).text).toBe("Question 1");
    expect((newEntries[2] as UserEntry).text).toBe("Question 2");
  });

  test("fork remaps a compaction boundary to the copied entry", async () => {
    const id = freshId();
    const log = await openSessionLog(id);
    log.append<UserEntry>({ type: "user", prompt: true, text: "old" });
    log.append<PhaseEntry>({ type: "phase", prompt: true, text: "old answer", runId: "r1" });
    const kept = log.append<UserEntry>({ type: "user", prompt: true, text: "kept" });
    const tail = log.append<PhaseEntry>({ type: "phase", prompt: true, text: "tail", runId: "r2" });
    log.append<CompactionEntry>({
      type: "compaction",
      prompt: true,
      summary: "old summary",
      firstKeptEntryId: kept.id,
      tokensBefore: 900,
      count: 2,
    });
    await log.flush();

    const manager = new SessionManager();
    const ctx = await createContext(id, log, { sessionManager: manager });
    const result = await handleForkCommand(ctx, "");
    const newLog = await openSessionLog(ctx.resolveNewSessionId(result.newThreadId!));
    const boundary = newLog.entries().find((entry): entry is CompactionEntry => entry.type === "compaction");
    const copiedKept = newLog.entries().find((entry): entry is UserEntry => entry.type === "user" && entry.text === "kept");
    const copiedTail = newLog.entries().find((entry): entry is PhaseEntry => entry.type === "phase" && entry.text === "tail");

    expect(boundary).toBeDefined();
    expect(copiedKept).toBeDefined();
    expect(copiedTail).toBeDefined();
    expect(boundary!.firstKeptEntryId).toBe(copiedKept!.id);
    expect(boundary!.firstKeptEntryId).not.toBe(kept.id);
    expect(contextEntries(newLog.entries(), newLog.leaf()).map((entry) => entry.id)).toEqual([
      boundary!.id,
      copiedKept!.id,
      copiedTail!.id,
    ]);
  });

  test("fork does not modify the source session", async () => {
    const id = freshId();
    const log = await openSessionLog(id);
    const user1 = log.append<UserEntry>({ type: "user", prompt: true, text: "Question" });
    const phase1 = log.append<PhaseEntry>({ type: "phase", prompt: true, text: "Réponse", runId: "r1" });
    await log.flush();

    // Capture source state before fork
    const sourceEntriesBefore = log.entries().map(e => e.id);
    const sourceLeafBefore = log.leaf();

    const manager = new SessionManager();
    const ctx = await createContext(id, log, { sessionManager: manager });
    await handleForkCommand(ctx, "");

    // Verify source is unchanged
    expect(log.entries().map(e => e.id)).toEqual(sourceEntriesBefore);
    expect(log.leaf()).toBe(sourceLeafBefore);
    expect(log.entries()[0]!.id).toBe(user1.id);
    expect(log.entries()[1]!.id).toBe(phase1.id);
  });

  test("fork from a specific entry copies only the path to that entry", async () => {
    const id = freshId();
    const log = await openSessionLog(id);
    const user1 = log.append<UserEntry>({ type: "user", prompt: true, text: "Question 1" });
    const phase1 = log.append<PhaseEntry>({ type: "phase", prompt: true, text: "Réponse 1", runId: "r1" });
    log.append<UserEntry>({ type: "user", prompt: true, text: "Question 2" });
    log.append<PhaseEntry>({ type: "phase", prompt: true, text: "Réponse 2", runId: "r2" });
    await log.flush();

    const manager = new SessionManager();
    const ctx = await createContext(id, log, { sessionManager: manager });
    // Fork from the first phase, not the leaf
    const result = await handleForkCommand(ctx, phase1.id);

    expect(result.text).toContain("2 entrée(s) copiée(s)");
    expect(result.newThreadId).toBeDefined();

    const newSessionId = ctx.resolveNewSessionId(result.newThreadId!);
    const newLog = await openSessionLog(newSessionId);
    expect(newLog.entries()).toHaveLength(2);
  });

  test("fork with unknown entryId returns error", async () => {
    const id = freshId();
    const log = await openSessionLog(id);
    log.append<UserEntry>({ type: "user", prompt: true, text: "Question" });
    await log.flush();

    const ctx = await createContext(id, log);
    const result = await handleForkCommand(ctx, "unknown-id");

    expect(result.text).toContain("inconnue");
    expect(result.newThreadId).toBeUndefined();
  });

  test("fork sets forkedFrom in meta.json", async () => {
    const id = freshId();
    const log = await openSessionLog(id);
    log.append<UserEntry>({ type: "user", prompt: true, text: "Question" });
    const phase1 = log.append<PhaseEntry>({ type: "phase", prompt: true, text: "Réponse", runId: "r1" });
    await log.flush();

    const manager = new SessionManager();
    const ctx = await createContext(id, log, { sessionManager: manager });
    const result = await handleForkCommand(ctx, "");

    const newSessionId = ctx.resolveNewSessionId(result.newThreadId!);
    const meta = await readMeta(newSessionId);

    expect(meta?.forkedFrom).toBeDefined();
    expect(meta?.forkedFrom?.sessionId).toBe(id);
    expect(meta?.forkedFrom?.entryId).toBe(phase1.id);
  });

  test("fork from mid-branch copies only the prefix", async () => {
    const id = freshId();
    const log = await openSessionLog(id);
    const user1 = log.append<UserEntry>({ type: "user", prompt: true, text: "Question" });
    const phase1 = log.append<PhaseEntry>({ type: "phase", prompt: true, text: "Réponse 1", runId: "r1" });
    // Create a branch
    log.branch(user1.id);
    log.append<PhaseEntry>({ type: "phase", prompt: true, text: "Réponse alternative", runId: "r2" });
    await log.flush();

    // Go back to the first branch and fork from phase1
    log.branch(phase1.id);
    const manager = new SessionManager();
    const ctx = await createContext(id, log, { sessionManager: manager });
    const result = await handleForkCommand(ctx, phase1.id);

    expect(result.newThreadId).toBeDefined();
    const newSessionId = ctx.resolveNewSessionId(result.newThreadId!);
    const newLog = await openSessionLog(newSessionId);

    // Should only have the path to phase1 (user1 + phase1)
    expect(newLog.entries()).toHaveLength(2);
    expect(pathOf(newLog.entries(), newLog.leaf()!).map(e => (e as UserEntry | PhaseEntry).text || (e as PhaseEntry).text))
      .toEqual(["Question", "Réponse 1"]);
  });

  test("fork copies attachments, and they survive source deletion", async () => {
    const id = freshId();
    const sourceThreadId = id.split("/").pop() ?? id;

    // Create attachment file in source thread
    const sourceFilesDir = join(MY_CLAW_DIR, "files", "my-claw-app", testOwner, sourceThreadId);
    await mkdir(sourceFilesDir, { recursive: true });
    const attachmentId = "test-att-id";
    const storedName = `${attachmentId}__photo.jpg`;
    const sourcePath = join(sourceFilesDir, storedName);
    await writeFile(sourcePath, "fake image content");

    // Create session with attachment
    const log = await openSessionLog(id);
    const attachment: SessionAttachment = { type: "image", path: sourcePath };
    log.append<UserEntry>({ type: "user", prompt: true, text: "Look at this", attachments: [attachment] });
    log.append<PhaseEntry>({ type: "phase", prompt: true, text: "Nice!", runId: "r1" });
    await log.flush();

    const manager = new SessionManager();
    const ctx = await createContext(id, log, { sessionManager: manager });
    const result = await handleForkCommand(ctx, "");

    expect(result.newThreadId).toBeDefined();

    // Verify attachment was copied
    const newSessionId = ctx.resolveNewSessionId(result.newThreadId!);
    const newLog = await openSessionLog(newSessionId);
    const newUserEntry = newLog.entries()[0] as UserEntry;
    expect(newUserEntry.attachments).toHaveLength(1);
    const newPath = newUserEntry.attachments![0]!.path;
    expect(newPath).not.toBe(sourcePath);
    expect(newPath).toContain(result.newThreadId!);

    // Verify the file exists
    const newFileStat = await stat(newPath);
    expect(newFileStat.isFile()).toBe(true);

    // Delete source files
    await rm(sourceFilesDir, { recursive: true, force: true });

    // Verify forked attachment is still readable
    const stillExists = await stat(newPath).then(() => true).catch(() => false);
    expect(stillExists).toBe(true);

    // Cleanup
    const newFilesDir = join(MY_CLAW_DIR, "files", "my-claw-app", testOwner, result.newThreadId!);
    await rm(newFilesDir, { recursive: true, force: true });
  });

  test("fork only copies attachments in the prefix, not after the fork point", async () => {
    const id = freshId();
    const sourceThreadId = id.split("/").pop() ?? id;

    // Create two attachment files
    const sourceFilesDir = join(MY_CLAW_DIR, "files", "my-claw-app", testOwner, sourceThreadId);
    await mkdir(sourceFilesDir, { recursive: true });
    const file1 = join(sourceFilesDir, "att1__before.jpg");
    const file2 = join(sourceFilesDir, "att2__after.jpg");
    await writeFile(file1, "before fork point");
    await writeFile(file2, "after fork point");

    // Create session with attachments before and after a point
    const log = await openSessionLog(id);
    log.append<UserEntry>({
      type: "user", prompt: true, text: "First",
      attachments: [{ type: "image", path: file1 }],
    });
    const phase1 = log.append<PhaseEntry>({ type: "phase", prompt: true, text: "R1", runId: "r1" });
    log.append<UserEntry>({
      type: "user", prompt: true, text: "Second",
      attachments: [{ type: "image", path: file2 }],
    });
    log.append<PhaseEntry>({ type: "phase", prompt: true, text: "R2", runId: "r2" });
    await log.flush();

    const manager = new SessionManager();
    const ctx = await createContext(id, log, { sessionManager: manager });
    // Fork from phase1, which is BEFORE the second user entry with file2
    const result = await handleForkCommand(ctx, phase1.id);

    expect(result.newThreadId).toBeDefined();

    // Check what files were copied
    const newFilesDir = join(MY_CLAW_DIR, "files", "my-claw-app", testOwner, result.newThreadId!);
    const copiedFiles = await readdir(newFilesDir).catch(() => []);

    // Only file1 (before.jpg) should be copied, not file2 (after.jpg)
    expect(copiedFiles).toHaveLength(1);
    expect(copiedFiles[0]).toContain("before.jpg");

    // Cleanup
    await rm(sourceFilesDir, { recursive: true, force: true });
    await rm(newFilesDir, { recursive: true, force: true });
  });

  test("fork continues when source attachment file is missing", async () => {
    const id = freshId();

    // Create session with an attachment that points to a non-existent file
    const log = await openSessionLog(id);
    const missingPath = "/nonexistent/path/to/file.jpg";
    log.append<UserEntry>({
      type: "user", prompt: true, text: "Look at this",
      attachments: [{ type: "image", path: missingPath }],
    });
    log.append<PhaseEntry>({ type: "phase", prompt: true, text: "Cannot see it", runId: "r1" });
    await log.flush();

    const manager = new SessionManager();
    const ctx = await createContext(id, log, { sessionManager: manager });

    // Fork should succeed, not throw
    const result = await handleForkCommand(ctx, "");
    expect(result.newThreadId).toBeDefined();
    expect(result.text).toContain("2 entrée(s) copiée(s)");

    // The entry should still have the attachment with the old (dead) path
    const newSessionId = ctx.resolveNewSessionId(result.newThreadId!);
    const newLog = await openSessionLog(newSessionId);
    const newUserEntry = newLog.entries()[0] as UserEntry;
    expect(newUserEntry.attachments).toHaveLength(1);
    expect(newUserEntry.attachments![0]!.path).toBe(missingPath);
  });
});

describe("branch-commands: /undo", () => {
  test("undo with no user turns returns an error", async () => {
    const id = freshId();
    const log = await openSessionLog(id);
    const ctx = await createContext(id, log);

    const result = await handleUndoCommand(ctx, "");
    expect(result.text).toContain("Rien à annuler");
    expect(result.reset).toBeUndefined();
  });

  test("undo moves cursor before the last user turn and returns the text", async () => {
    const id = freshId();
    const log = await openSessionLog(id);
    const user1 = log.append<UserEntry>({ type: "user", prompt: true, text: "Question 1" });
    log.append<PhaseEntry>({ type: "phase", prompt: true, text: "Réponse 1", runId: "r1" });
    await log.flush();

    const ctx = await createContext(id, log);
    const result = await handleUndoCommand(ctx, "");

    expect(result.reset).toBe("branch-switch");
    expect(result.compose).toBe("Question 1");
    expect(result.text).toContain("/redo pour revenir");
    expect(log.leaf()).toBe(user1.parentId); // null (root)
  });

  test("undo aborts a running turn", async () => {
    const id = freshId();
    const log = await openSessionLog(id);
    log.append<UserEntry>({ type: "user", prompt: true, text: "Question" });
    log.append<PhaseEntry>({ type: "phase", prompt: true, text: "Réponse", runId: "r1" });
    await log.flush();

    let abortCalled = false;
    const ctx = await createContext(id, log, {
      isRunning: true,
      onAbort: () => { abortCalled = true; },
    });

    const result = await handleUndoCommand(ctx, "");

    expect(abortCalled).toBe(true);
    expect(result.reset).toBe("branch-switch");
  });

  test("undo saves undo state for redo", async () => {
    const id = freshId();
    const log = await openSessionLog(id);
    log.append<UserEntry>({ type: "user", prompt: true, text: "Question" });
    log.append<PhaseEntry>({ type: "phase", prompt: true, text: "Réponse", runId: "r1" });
    const oldLeaf = log.leaf()!;
    await log.flush();

    const ctx = await createContext(id, log);
    await handleUndoCommand(ctx, "");

    const meta = await readMeta(id);
    expect(meta?.undo).toBeDefined();
    expect(meta?.undo?.redoLeafId).toBe(oldLeaf);
    expect(meta?.undo?.expectedLeafId).toBe(log.leaf() ?? "");
  });

  test("undo in series until root, then undo again returns error", async () => {
    const id = freshId();
    const log = await openSessionLog(id);
    log.append<UserEntry>({ type: "user", prompt: true, text: "Question 1" });
    log.append<PhaseEntry>({ type: "phase", prompt: true, text: "Réponse 1", runId: "r1" });
    await log.flush();

    const ctx = await createContext(id, log);

    // First undo succeeds
    const result1 = await handleUndoCommand(ctx, "");
    expect(result1.reset).toBe("branch-switch");
    expect(log.leaf()).toBeNull();

    // Second undo fails: at root, no user turn to undo
    const result2 = await handleUndoCommand(ctx, "");
    expect(result2.text).toContain("Rien à annuler");
    expect(result2.reset).toBeUndefined();
  });

  test("undo leaves the abandoned branch visible in /branches", async () => {
    const id = freshId();
    const log = await openSessionLog(id);
    log.append<UserEntry>({ type: "user", prompt: true, text: "Question" });
    log.append<PhaseEntry>({ type: "phase", prompt: true, text: "Réponse", runId: "r1" });
    await log.flush();

    const ctx = await createContext(id, log);
    await handleUndoCommand(ctx, "");

    // The abandoned branch should still be visible
    const branchesResult = await handleBranchesCommand(ctx, "");
    expect(branchesResult.text).toContain("1 branche");
    expect(branchesResult.text).toContain("Question");
  });
});

describe("branch-commands: /redo", () => {
  test("redo without prior undo returns error", async () => {
    const id = freshId();
    const log = await openSessionLog(id);
    log.append<UserEntry>({ type: "user", prompt: true, text: "Question" });
    log.append<PhaseEntry>({ type: "phase", prompt: true, text: "Réponse", runId: "r1" });
    await log.flush();

    const ctx = await createContext(id, log);
    const result = await handleRedoCommand(ctx, "");

    expect(result.text).toContain("pas de /undo en attente");
    expect(result.reset).toBeUndefined();
  });

  test("redo after undo returns to the previous state", async () => {
    const id = freshId();
    const log = await openSessionLog(id);
    log.append<UserEntry>({ type: "user", prompt: true, text: "Question" });
    const phase1 = log.append<PhaseEntry>({ type: "phase", prompt: true, text: "Réponse", runId: "r1" });
    await log.flush();

    const ctx = await createContext(id, log);
    await handleUndoCommand(ctx, "");
    expect(log.leaf()).toBeNull();

    const result = await handleRedoCommand(ctx, "");
    expect(result.reset).toBe("branch-switch");
    expect(log.leaf()).toBe(phase1.id);
  });

  test("redo twice in a row: second fails", async () => {
    const id = freshId();
    const log = await openSessionLog(id);
    log.append<UserEntry>({ type: "user", prompt: true, text: "Question" });
    log.append<PhaseEntry>({ type: "phase", prompt: true, text: "Réponse", runId: "r1" });
    await log.flush();

    const ctx = await createContext(id, log);
    await handleUndoCommand(ctx, "");

    // First redo succeeds
    const result1 = await handleRedoCommand(ctx, "");
    expect(result1.reset).toBe("branch-switch");

    // Second redo fails: undo state was cleared
    const result2 = await handleRedoCommand(ctx, "");
    expect(result2.text).toContain("pas de /undo en attente");
    expect(result2.reset).toBeUndefined();
  });

  test("redo after undo then new turn: refuses and points to /branches", async () => {
    const id = freshId();
    const log = await openSessionLog(id);
    log.append<UserEntry>({ type: "user", prompt: true, text: "Question 1" });
    log.append<PhaseEntry>({ type: "phase", prompt: true, text: "Réponse 1", runId: "r1" });
    await log.flush();

    const ctx = await createContext(id, log);
    await handleUndoCommand(ctx, "");

    // Write a new turn (simulates the user typing after undo)
    log.append<UserEntry>({ type: "user", prompt: true, text: "Question 2" });
    log.append<PhaseEntry>({ type: "phase", prompt: true, text: "Réponse 2", runId: "r2" });
    await log.flush();

    // Persist to update leafId in meta (the real flow does this via persist())
    await ctx.persist();

    // Redo should refuse
    const result = await handleRedoCommand(ctx, "");
    expect(result.text).toContain("Redo impossible");
    expect(result.text).toContain("évolué depuis le /undo");
    expect(result.text).toContain("branche");
    expect(result.reset).toBeUndefined();
  });

  test("redo clears undo state after success", async () => {
    const id = freshId();
    const log = await openSessionLog(id);
    log.append<UserEntry>({ type: "user", prompt: true, text: "Question" });
    log.append<PhaseEntry>({ type: "phase", prompt: true, text: "Réponse", runId: "r1" });
    await log.flush();

    const ctx = await createContext(id, log);
    await handleUndoCommand(ctx, "");

    // Verify undo state exists
    let meta = await readMeta(id);
    expect(meta?.undo).toBeDefined();

    await handleRedoCommand(ctx, "");

    // Verify undo state is cleared
    meta = await readMeta(id);
    expect(meta?.undo).toBeUndefined();
  });
});
