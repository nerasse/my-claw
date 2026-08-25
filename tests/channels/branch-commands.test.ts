import { describe, test, expect, afterEach } from "bun:test";
import { mkdir, rm, writeFile, stat, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  handleRetryCommand,
  handleBranchesCommand,
  handleForkCommand,
  type BranchCommandContext,
} from "../../src/channels/branch-commands.ts";
import {
  openSessionLog,
  pathOf,
  type SessionLog,
  type UserEntry,
  type PhaseEntry,
} from "../../src/sessions/log.ts";
import { readMeta, writeMeta, metaOf } from "../../src/sessions/meta.ts";
import type { SessionData, SessionAttachment } from "../../src/sessions/store.ts";
import { SessionManager } from "../../src/sessions/manager.ts";
import { MY_CLAW_DIR } from "../../src/core/config.ts";

let counter = 0;
function freshId(): string {
  return `test-branch-${process.pid}-${counter++}`;
}

function createMockSession(sessionId: string): SessionData {
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

async function createContext(
  sessionId: string,
  log: SessionLog,
  isRunning = false,
  sessionManager?: SessionManager,
): Promise<BranchCommandContext> {
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
    persist: async () => {
      const meta = metaOf(session, log.leaf());
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
    const ctx = await createContext(id, log, false, manager);
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
    const ctx = await createContext(id, log, false, manager);
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
    const ctx = await createContext(id, log, false, manager);
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
    const ctx = await createContext(id, log, false, manager);
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
    const ctx = await createContext(id, log, false, manager);
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
    const ctx = await createContext(id, log, false, manager);
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
    const ctx = await createContext(id, log, false, manager);
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
    const ctx = await createContext(id, log, false, manager);

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
