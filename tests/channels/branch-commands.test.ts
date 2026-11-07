import { describe, test, expect, afterEach } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile, readFile, stat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
  type CommandEntry,
  type RunStartEntry,
  type RunEndEntry,
} from "../../src/sessions/log.ts";
import { contextEntries } from "../../src/sessions/projection.ts";
import { readMeta, writeMeta, metaOf } from "../../src/sessions/meta.ts";
import type { LegacySessionData, SessionAttachment } from "../../src/sessions/store.ts";
import { SessionManager } from "../../src/sessions/manager.ts";
import { MY_CLAW_DIR } from "../../src/core/config.ts";
import { recordRunStart, recordRunEnd, clearSessionSnapshots } from "../../src/snapshots/store.ts";

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
  isCompacting?: boolean;
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
  const { isRunning = false, isCompacting = false, sessionManager, onAbort } = opts;

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
    isCompacting: () => isCompacting,
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

  test("retry refuses while a compaction holds the session", async () => {
    const id = freshId();
    const log = await openSessionLog(id);
    log.append<UserEntry>({ type: "user", prompt: true, text: "Question" });
    const answer = log.append<PhaseEntry>({ type: "phase", prompt: true, text: "Réponse", runId: "r1" });
    await log.flush();

    const ctx = await createContext(id, log, { isCompacting: true });
    const result = await handleRetryCommand(ctx, "");
    expect(result.text).toContain("compaction");
    expect(result.reset).toBeUndefined();
    expect(log.leaf()).toBe(answer.id);
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

  test("branches <n> refuses while a compaction holds the session", async () => {
    // Same reason as a run: the boundary about to be written would land on the branch switched
    // to, summarizing a history that is no longer the one on screen.
    const id = freshId();
    const log = await openSessionLog(id);
    log.append<UserEntry>({ type: "user", prompt: true, text: "Question" });
    await log.flush();

    const ctx = await createContext(id, log, { isCompacting: true });
    const result = await handleBranchesCommand(ctx, "1");

    expect(result.text).toContain("compaction");
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
    expect((await newLog.all())).toHaveLength(4);

    // Verify entries are properly chained (parentIds form a linked list)
    const newEntries = (await newLog.all());
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
    const boundary = (await newLog.all()).find((entry): entry is CompactionEntry => entry.type === "compaction");
    const copiedKept = (await newLog.all()).find((entry): entry is UserEntry => entry.type === "user" && entry.text === "kept");
    const copiedTail = (await newLog.all()).find((entry): entry is PhaseEntry => entry.type === "phase" && entry.text === "tail");

    expect(boundary).toBeDefined();
    expect(copiedKept).toBeDefined();
    expect(copiedTail).toBeDefined();
    expect(boundary!.firstKeptEntryId).toBe(copiedKept!.id);
    expect(boundary!.firstKeptEntryId).not.toBe(kept.id);
    expect(contextEntries((await newLog.all()), newLog.leaf()).map((entry) => entry.id)).toEqual([
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
    const sourceEntriesBefore = (await log.all()).map(e => e.id);
    const sourceLeafBefore = log.leaf();

    const manager = new SessionManager();
    const ctx = await createContext(id, log, { sessionManager: manager });
    await handleForkCommand(ctx, "");

    // Verify source is unchanged
    expect((await log.all()).map(e => e.id)).toEqual(sourceEntriesBefore);
    expect(log.leaf()).toBe(sourceLeafBefore);
    expect((await log.all())[0]!.id).toBe(user1.id);
    expect((await log.all())[1]!.id).toBe(phase1.id);
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
    expect((await newLog.all())).toHaveLength(2);
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
    expect((await newLog.all())).toHaveLength(2);
    expect(pathOf((await newLog.all()), newLog.leaf()!).map(e => (e as UserEntry | PhaseEntry).text || (e as PhaseEntry).text))
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
    const newUserEntry = (await newLog.all())[0] as UserEntry;
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
    const newUserEntry = (await newLog.all())[0] as UserEntry;
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

  test("undo soft keeps files untouched and reports no restore", async () => {
    const id = freshId();
    const log = await openSessionLog(id);
    log.append<UserEntry>({ type: "user", prompt: true, text: "Question" });
    log.append<PhaseEntry>({ type: "phase", prompt: true, text: "Réponse", runId: "r1" });
    await log.flush();

    const ctx = await createContext(id, log);
    const result = await handleUndoCommand(ctx, "soft");

    expect(result.reset).toBe("branch-switch");
    expect(result.text).not.toContain("Fichiers restaurés");
  });

  test("undo hard with no snapshot reports it", async () => {
    const id = freshId();
    const log = await openSessionLog(id);
    log.append<UserEntry>({ type: "user", prompt: true, text: "Question" });
    log.append<PhaseEntry>({ type: "phase", prompt: true, text: "Réponse", runId: "r1" });
    await log.flush();

    const ctx = await createContext(id, log);
    const result = await handleUndoCommand(ctx, "hard");

    expect(result.text).toContain("Aucun snapshot");
  });

  /** A turn whose run changed a file: the case where soft and hard differ, and the sheet asks. */
  async function turnThatWroteAFile(id: string): Promise<{ log: SessionLog; ws: string }> {
    const ws = await mkdtemp(join(tmpdir(), "undo-ask-"));
    await writeFile(join(ws, "note.txt"), "v0\n");
    await recordRunStart(id, ws, "r1");
    await writeFile(join(ws, "note.txt"), "v1\n");
    await recordRunEnd(id, "r1", ws);
    const log = await openSessionLog(id);
    log.append<UserEntry>({ type: "user", prompt: true, text: "Question" });
    log.append<RunStartEntry>({ type: "run_start", prompt: false, runId: "r1" });
    log.append<PhaseEntry>({ type: "phase", prompt: true, text: "Réponse", runId: "r1" });
    await log.flush();
    return { log, ws };
  }

  test("undo without argument asks and uses the chosen mode", async () => {
    const id = freshId();
    const { log, ws } = await turnThatWroteAFile(id);

    let asked = false;
    const ctx = await createContext(id, log);
    const withPrompt: BranchCommandContext = {
      ...ctx,
      undoPrompt: async (input) => {
        asked = true;
        expect(input.turnPreview).toContain("Question");
        return "soft";
      },
    };
    const result = await handleUndoCommand(withPrompt, "");

    expect(asked).toBe(true);
    expect(result.reset).toBe("branch-switch");
    await clearSessionSnapshots(id);
    await rm(ws, { recursive: true, force: true });
  });

  test("undo without argument and dismissed returns cancel text", async () => {
    const id = freshId();
    const { log, ws } = await turnThatWroteAFile(id);

    const ctx = await createContext(id, log);
    const withPrompt: BranchCommandContext = {
      ...ctx,
      undoPrompt: async () => null,
    };
    const result = await handleUndoCommand(withPrompt, "");

    expect(result.text).toContain("Undo annulé");
    expect(result.reset).toBeUndefined();
    await clearSessionSnapshots(id);
    await rm(ws, { recursive: true, force: true });
  });

  test("undo with invalid argument returns usage", async () => {
    const id = freshId();
    const log = await openSessionLog(id);
    const ctx = await createContext(id, log);

    const result = await handleUndoCommand(ctx, "bogus");
    expect(result.text).toContain("Usage");
  });

  test("a compaction is a turn: undo rewinds before it and nothing else", async () => {
    // The owner's model: a compaction is one more thing that happened to the conversation,
    // like a message. Undoing right after a /compact takes the boundary back and leaves the
    // turn it summarized exactly where it was.
    const id = freshId();
    const log = await openSessionLog(id);
    log.append<UserEntry>({ type: "user", prompt: true, text: "Question" });
    log.append<RunStartEntry>({ type: "run_start", prompt: false, runId: "r1" });
    log.append<PhaseEntry>({ type: "phase", prompt: true, text: "Réponse", runId: "r1" });
    const end = log.append<RunEndEntry>({ type: "run_end", prompt: false, reason: "done" });
    log.append<CompactionEntry>({
      type: "compaction",
      prompt: true,
      summary: "ce qui precede",
      firstKeptEntryId: end.id,
      tokensBefore: 900,
      count: 12,
    });
    // The /compact's own journal entry lands after the boundary, the way the app writes it.
    const journal = log.append<CommandEntry>({ type: "command", prompt: false, input: "/compact", output: "" });
    await log.flush();

    const ctx = await createContext(id, log);
    const result = await handleUndoCommand(ctx, "");

    expect(result.reset).toBe("branch-switch");
    expect(result.text).toContain("compaction");
    expect(result.text).toContain("12");
    expect(result.text).toContain("/redo pour revenir");
    // Nothing to put back in the composer: no message was undone.
    expect(result.compose).toBeUndefined();
    expect(log.leaf()).toBe(end.id);

    const meta = await readMeta(id);
    expect(meta?.undo?.redoLeafId).toBe(journal.id);
    expect(meta?.undo?.expectedLeafId).toBe(end.id);
  });

  test("undoing a compaction never asks soft or hard: no file was touched", async () => {
    const id = freshId();
    const log = await openSessionLog(id);
    const user = log.append<UserEntry>({ type: "user", prompt: true, text: "Question" });
    log.append<CompactionEntry>({
      type: "compaction",
      prompt: true,
      summary: "s",
      firstKeptEntryId: user.id,
      tokensBefore: 900,
      count: 3,
    });
    await log.flush();

    let prompted = false;
    const ctx = await createContext(id, log);
    ctx.undoPrompt = async () => {
      prompted = true;
      return "hard";
    };
    const result = await handleUndoCommand(ctx, "");

    expect(prompted).toBe(false);
    expect(result.reset).toBe("branch-switch");
    expect(log.leaf()).toBe(user.id);
  });

  test("a compaction inside the run belongs to the message's turn", async () => {
    // Mid-run, the gate summarized the history between two iterations. The compaction is part of
    // the work done for the message, so undoing takes the whole turn, as it always did.
    const id = freshId();
    const log = await openSessionLog(id);
    const before = log.append<UserEntry>({ type: "user", prompt: true, text: "Earlier" });
    const user = log.append<UserEntry>({ type: "user", prompt: true, text: "Question" });
    log.append<RunStartEntry>({ type: "run_start", prompt: false, runId: "r1" });
    log.append<PhaseEntry>({ type: "phase", prompt: true, text: "Working", runId: "r1" });
    log.append<CompactionEntry>({
      type: "compaction",
      prompt: true,
      summary: "s",
      firstKeptEntryId: user.id,
      tokensBefore: 900,
      count: 5,
    });
    log.append<PhaseEntry>({ type: "phase", prompt: true, text: "Réponse", runId: "r1" });
    log.append<RunEndEntry>({ type: "run_end", prompt: false, reason: "done" });
    await log.flush();

    const ctx = await createContext(id, log);
    const result = await handleUndoCommand(ctx, "soft");

    expect(result.compose).toBe("Question");
    expect(log.leaf()).toBe(before.id);
  });

  test("a compaction still running is the turn in flight: undo stops it and rewinds nothing", async () => {
    const id = freshId();
    const log = await openSessionLog(id);
    log.append<UserEntry>({ type: "user", prompt: true, text: "Question" });
    const answer = log.append<PhaseEntry>({ type: "phase", prompt: true, text: "Réponse", runId: "r1" });
    await log.flush();

    let abortCalled = false;
    const ctx = await createContext(id, log, {
      isCompacting: true,
      onAbort: () => { abortCalled = true; },
    });
    const result = await handleUndoCommand(ctx, "");

    expect(abortCalled).toBe(true);
    expect(result.reset).toBeUndefined();
    expect(result.text).toContain("compaction");
    expect(log.leaf()).toBe(answer.id);
    expect((await readMeta(id))?.undo).toBeUndefined();
  });
});

/**
 * `/undo` and the files: the snapshots the runs really record, read back the way `/undo` reads
 * them. The capture tests hand the same shadow directory to the capture and to the diff, so they
 * could not see that the store wrote its shadows under one root and `/undo` read them from another:
 * every diff came back +0/-0 and no hard undo ever restored a file (2026-10-02).
 */
describe("branch-commands: /undo and the files", () => {
  const made: Array<{ ws: string; session: string }> = [];
  afterEach(async () => {
    for (const { ws, session } of made.splice(0)) {
      await clearSessionSnapshots(session);
      await rm(ws, { recursive: true, force: true });
    }
  });

  async function workspace(session: string): Promise<string> {
    const ws = await mkdtemp(join(tmpdir(), "undo-ws-"));
    made.push({ ws, session });
    return ws;
  }

  /** One turn on the log, with the run markers the bridge writes, named like the snapshots. */
  async function turn(id: string, runIds: string[]): Promise<SessionLog> {
    const log = await openSessionLog(id);
    log.append<UserEntry>({ type: "user", prompt: true, text: "Question" });
    for (const runId of runIds) {
      log.append<RunStartEntry>({ type: "run_start", prompt: false, runId });
      log.append<PhaseEntry>({ type: "phase", prompt: true, text: "Réponse", runId });
      log.append<RunEndEntry>({ type: "run_end", prompt: false, reason: "done" });
    }
    await log.flush();
    return log;
  }

  function asking(ctx: BranchCommandContext, asked: Array<Parameters<NonNullable<BranchCommandContext["undoPrompt"]>>[0]>, answer: "soft" | "hard" = "soft"): BranchCommandContext {
    return { ...ctx, undoPrompt: async (input) => { asked.push(input); return answer; } };
  }

  test("a turn that changed no file is rewound at once: the sheet would offer nothing", async () => {
    const id = freshId();
    const ws = await workspace(id);
    await writeFile(join(ws, "note.txt"), "v0\n");
    await recordRunStart(id, ws, "r1");
    await recordRunEnd(id, "r1", ws);
    const log = await turn(id, ["r1"]);

    const asked: unknown[] = [];
    const result = await handleUndoCommand(asking(await createContext(id, log), asked as never), "");

    expect(asked).toEqual([]);
    expect(result.reset).toBe("branch-switch");
    expect(result.text).toContain("aucun fichier modifié");
  });

  test("a turn with no snapshot to restore is rewound at once too", async () => {
    const id = freshId();
    const log = await turn(id, ["r1"]);
    const asked: unknown[] = [];
    const result = await handleUndoCommand(asking(await createContext(id, log), asked as never), "");
    expect(asked).toEqual([]);
    expect(result.reset).toBe("branch-switch");
  });

  test("a change git counts as +0/-0 still opens the sheet: a binary file is a changed file", async () => {
    const id = freshId();
    const ws = await workspace(id);
    await writeFile(join(ws, "logo.bin"), Buffer.from([0, 1, 2]));
    await recordRunStart(id, ws, "r1");
    await writeFile(join(ws, "logo.bin"), Buffer.from([0, 9, 9, 9]));
    await recordRunEnd(id, "r1", ws);
    const log = await turn(id, ["r1"]);

    const asked: Array<Parameters<NonNullable<BranchCommandContext["undoPrompt"]>>[0]> = [];
    await handleUndoCommand(asking(await createContext(id, log), asked), "");

    expect(asked).toHaveLength(1);
    expect(asked[0]!.diff.reduce((sum, depot) => sum + depot.files, 0)).toBe(1);
  });

  test("what a run wrote before /undo stopped it counts: the diff is against the files as they are", async () => {
    const id = freshId();
    const ws = await workspace(id);
    await writeFile(join(ws, "note.txt"), "v0\n");
    await recordRunStart(id, ws, "r1");
    await writeFile(join(ws, "note.txt"), "v0\nv1\n");
    // The run is stopped by the /undo itself: it never reaches its end, nor its after snapshot.
    const log = await openSessionLog(id);
    log.append<UserEntry>({ type: "user", prompt: true, text: "Question" });
    log.append<RunStartEntry>({ type: "run_start", prompt: false, runId: "r1" });
    await log.flush();

    const asked: Array<Parameters<NonNullable<BranchCommandContext["undoPrompt"]>>[0]> = [];
    await handleUndoCommand(asking(await createContext(id, log, { isRunning: true }), asked), "");

    expect(asked).toHaveLength(1);
    expect(asked[0]!.diff.some((depot) => depot.files === 1 && depot.additions === 1)).toBe(true);
  });

  test("files git cannot compare are not \"nothing changed\": the sheet asks", async () => {
    const id = freshId();
    const ws = await workspace(id);
    await writeFile(join(ws, "note.txt"), "v0\n");
    const run = await recordRunStart(id, ws, "r1");
    // A tree the shadow no longer holds (pruned, or a store that moved): the diff cannot be read.
    const file = join(MY_CLAW_DIR, "snapshots", "session", id, "r1.json");
    await writeFile(file, JSON.stringify({ ...run, before: { ...run.before, depots: run.before.depots.map((depot) => ({ ...depot, treeId: "0123456789abcdef0123456789abcdef01234567" })) } }));
    const log = await turn(id, ["r1"]);

    const asked: Array<Parameters<NonNullable<BranchCommandContext["undoPrompt"]>>[0]> = [];
    await handleUndoCommand(asking(await createContext(id, log), asked), "");

    expect(asked).toHaveLength(1);
  });

  test("hard restores the files as they were before the turn, its Continue included", async () => {
    const id = freshId();
    const ws = await workspace(id);
    await writeFile(join(ws, "note.txt"), "v0\n");
    await recordRunStart(id, ws, "r1");
    await writeFile(join(ws, "note.txt"), "v1\n");
    await recordRunEnd(id, "r1", ws);
    // The turn was picked back up with Continue: a second run, a second snapshot, newer.
    await recordRunStart(id, ws, "r2");
    await writeFile(join(ws, "note.txt"), "v2\n");
    await writeFile(join(ws, "added.txt"), "later\n");
    await recordRunEnd(id, "r2", ws);
    const log = await turn(id, ["r1", "r2"]);

    const result = await handleUndoCommand(await createContext(id, log), "hard");

    expect(result.text).toContain("Fichiers restaurés");
    expect(await readFile(join(ws, "note.txt"), "utf8")).toBe("v0\n");
    expect(await stat(join(ws, "added.txt")).then(() => true, () => false)).toBe(false);
  });

  test("an older turn's snapshot is not this turn's: a turn whose runs recorded nothing restores nothing", async () => {
    const id = freshId();
    const ws = await workspace(id);
    await writeFile(join(ws, "note.txt"), "v0\n");
    // An earlier turn of the same conversation, whose run did record a snapshot.
    await recordRunStart(id, ws, "earlier");
    await recordRunEnd(id, "earlier", ws);
    const log = await openSessionLog(id);
    log.append<UserEntry>({ type: "user", prompt: true, text: "Earlier" });
    log.append<RunStartEntry>({ type: "run_start", prompt: false, runId: "earlier" });
    log.append<PhaseEntry>({ type: "phase", prompt: true, text: "Done", runId: "earlier" });
    log.append<RunEndEntry>({ type: "run_end", prompt: false, reason: "done" });
    // The turn undone: its run recorded nothing (a capture that failed).
    log.append<UserEntry>({ type: "user", prompt: true, text: "Question" });
    log.append<RunStartEntry>({ type: "run_start", prompt: false, runId: "r1" });
    log.append<PhaseEntry>({ type: "phase", prompt: true, text: "Réponse", runId: "r1" });
    log.append<RunEndEntry>({ type: "run_end", prompt: false, reason: "done" });
    await log.flush();
    await writeFile(join(ws, "note.txt"), "edited by hand\n");

    const result = await handleUndoCommand(await createContext(id, log), "hard");

    expect(result.text).toContain("Aucun snapshot");
    expect(await readFile(join(ws, "note.txt"), "utf8")).toBe("edited by hand\n");
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


  test("the journal entry of the undo itself does not count as a new turn", async () => {
    // The app writes every command, quiet ones included, as a `command` entry at the leaf the
    // command left. That entry lands right after /undo moved the branch, so an exact-leaf check
    // refused every /redo the app ever sent. Display-only entries are not a turn.
    const id = freshId();
    const log = await openSessionLog(id);
    log.append<UserEntry>({ type: "user", prompt: true, text: "Question" });
    const phase1 = log.append<PhaseEntry>({ type: "phase", prompt: true, text: "Réponse", runId: "r1" });
    await log.flush();

    const ctx = await createContext(id, log);
    await handleUndoCommand(ctx, "soft");
    log.append<CommandEntry>({ type: "command", prompt: false, input: "/undo", output: "Undo", quiet: true });

    const result = await handleRedoCommand(ctx, "");
    expect(result.reset).toBe("branch-switch");
    expect(log.leaf()).toBe(phase1.id);
  });

  test("redo restores an undone compaction, journal entry included", async () => {
    const id = freshId();
    const log = await openSessionLog(id);
    log.append<UserEntry>({ type: "user", prompt: true, text: "Question" });
    const end = log.append<PhaseEntry>({ type: "phase", prompt: true, text: "Réponse", runId: "r1" });
    const boundary = log.append<CompactionEntry>({
      type: "compaction",
      prompt: true,
      summary: "s",
      firstKeptEntryId: end.id,
      tokensBefore: 900,
      count: 2,
    });
    const journal = log.append<CommandEntry>({ type: "command", prompt: false, input: "/compact", output: "" });
    await log.flush();

    const ctx = await createContext(id, log);
    await handleUndoCommand(ctx, "");
    expect(log.leaf()).toBe(end.id);
    log.append<CommandEntry>({ type: "command", prompt: false, input: "/undo", output: "Undo", quiet: true });

    const result = await handleRedoCommand(ctx, "");
    expect(result.reset).toBe("branch-switch");
    expect(log.leaf()).toBe(journal.id);
    expect((await log.path()).map((e) => e.id)).toContain(boundary.id);
  });

  test("a compaction written since the undo is a turn: redo refuses", async () => {
    const id = freshId();
    const log = await openSessionLog(id);
    const user = log.append<UserEntry>({ type: "user", prompt: true, text: "Question" });
    log.append<PhaseEntry>({ type: "phase", prompt: true, text: "Réponse", runId: "r1" });
    await log.flush();

    const ctx = await createContext(id, log);
    await handleUndoCommand(ctx, "soft");
    log.append<CompactionEntry>({
      type: "compaction",
      prompt: true,
      summary: "s",
      firstKeptEntryId: user.id,
      tokensBefore: 900,
      count: 1,
    });

    const result = await handleRedoCommand(ctx, "");
    expect(result.text).toContain("Redo impossible");
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
