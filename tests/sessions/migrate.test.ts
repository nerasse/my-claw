import { describe, test, expect, beforeEach } from "bun:test";
import { mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { MY_CLAW_DIR } from "../../src/core/config.ts";
import { migrateSessions, legacySessionIds } from "../../src/sessions/migrate.ts";
import { openSessionLog, entriesPath, sessionDir } from "../../src/sessions/log.ts";
import { readMeta, metaPath, metaOf, STORAGE_VERSION, UnsupportedStorageVersionError } from "../../src/sessions/meta.ts";
import { promptOf } from "../../src/sessions/projection.ts";
import type { LegacySessionData, SessionMessage } from "../../src/sessions/store.ts";

const SESSIONS_DIR = join(MY_CLAW_DIR, "sessions");
const ARCHIVES_DIR = join(MY_CLAW_DIR, "sessions-archive");

const at = (n: number) => new Date(1_800_000_000_000 + n * 1000).toISOString();

function data(id: string, messages: SessionMessage[], extra: Partial<LegacySessionData> = {}): LegacySessionData {
  return {
    id, platform: "my-claw-app", chatType: "thread",
    createdAt: at(0), lastActiveAt: at(9), messages, ...extra,
  } as LegacySessionData;
}

/** Writes the legacy file the migration is supposed to find. */
async function writeLegacy(session: LegacySessionData): Promise<void> {
  const path = join(SESSIONS_DIR, `${session.id}.json`);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(session), "utf-8");
}

/** The read the pass is handed: the real one, minus the manager. */
const readLegacy = async (sessionId: string): Promise<LegacySessionData | null> => {
  try {
    return JSON.parse(await readFile(join(SESSIONS_DIR, `${sessionId}.json`), "utf-8")) as LegacySessionData;
  } catch {
    return null;
  }
};

const userMsg = (content: string, n: number): SessionMessage => ({ role: "user", content, timestamp: at(n) });
const assistantMsg = (content: string, n: number, extra: Record<string, unknown> = {}): SessionMessage =>
  ({ role: "assistant", content, timestamp: at(n), ...extra }) as SessionMessage;

beforeEach(async () => {
  await rm(SESSIONS_DIR, { recursive: true, force: true });
  await rm(ARCHIVES_DIR, { recursive: true, force: true });
  await mkdir(SESSIONS_DIR, { recursive: true });
});

describe("legacySessionIds", () => {
  test("finds the three families, nested ids included", async () => {
    // cron sessions are not deleted after a run: pruneSessions keeps 25 per job, and the app
    // opens them as chats. Skipping them would strand every one of them.
    await writeLegacy(data("my-claw-app/thread/neras/abc", []));
    await writeLegacy(data("subagent/researcher-a7b3", []));
    await writeLegacy(data("cron/0123456789ab/1700000000", []));
    expect((await legacySessionIds()).sort()).toEqual([
      "cron/0123456789ab/1700000000",
      "my-claw-app/thread/neras/abc",
      "subagent/researcher-a7b3",
    ]);
  });

  test("a directory with no legacy file in it yields nothing", async () => {
    await mkdir(sessionDir("my-claw-app/thread/neras/abc"), { recursive: true });
    expect(await legacySessionIds()).toEqual([]);
  });

  /**
   * The empty conversation that crash-looped 0.4.55. `appendAll([])` writes no file, so the
   * migration left settings and no log; keyed on the log alone this read as "not a session", so
   * the walk went inside and offered `<id>/meta`, whose `meta.json` then loaded as a session with
   * no `messages`. It also meant the conversation was re-migrated on every single boot.
   */
  test("a migrated conversation with no log is not offered again, nor its meta as a session", async () => {
    const id = "my-claw-app/thread/neras/empty";
    await mkdir(sessionDir(id), { recursive: true });
    await writeFile(metaPath(id), JSON.stringify({
      id, platform: "my-claw-app", chatType: "dm",
      createdAt: at(0), lastActiveAt: at(0), storageVersion: STORAGE_VERSION, leafId: null,
    }), "utf-8");

    expect(await legacySessionIds()).toEqual([]);
  });

  test("a conversation opened for the first time gets its log straight away", async () => {
    const id = "my-claw-app/thread/neras/fresh";
    await openSessionLog(id);
    expect(await readFile(entriesPath(id), "utf-8")).toBe("");
    // Which is what keeps the walk from ever seeing the settings-only shape again.
    expect(await legacySessionIds()).toEqual([]);
  });
});

describe("migrateSessions", () => {
  test("a conversation becomes a directory and its file is archived", async () => {
    await writeLegacy(data("t1", [userMsg("bonjour", 1), assistantMsg("salut", 2)]));
    expect(await migrateSessions(readLegacy)).toEqual({ migrated: 1, skipped: 0, failed: 0 });

    const entries = (await openSessionLog("t1")).entries();
    expect(entries.map((e) => e.type)).toEqual(["user", "phase"]);
    expect(await readMeta("t1")).toMatchObject({ id: "t1", storageVersion: STORAGE_VERSION, leafId: entries[1]!.id });

    // The legacy file is moved, not deleted: it is the only copy until the new one is proven.
    expect(await readLegacy("t1")).toBeNull();
    const archived = await readdir(join(ARCHIVES_DIR, "t1"));
    expect(archived).toHaveLength(1);
  });

  test("running it twice changes nothing", async () => {
    // A boot interrupted halfway must resume, and a normal boot must be free.
    await writeLegacy(data("t1", [userMsg("q", 1)]));
    await migrateSessions(readLegacy);
    const before = await readFile(entriesPath("t1"), "utf-8");
    expect(await migrateSessions(readLegacy)).toEqual({ migrated: 0, skipped: 0, failed: 0 });
    expect(await readFile(entriesPath("t1"), "utf-8")).toBe(before);
  });

  test("a session already migrated whose legacy file came back is not doubled, nor counted", async () => {
    await writeLegacy(data("t1", [userMsg("q", 1)]));
    await migrateSessions(readLegacy);
    // `persist` rewrites one on every turn, so this is the steady state, not an accident. It used
    // to be offered and then skipped, which put a permanent count on an install that was fine.
    await writeLegacy(data("t1", [userMsg("q", 1)]));
    expect(await migrateSessions(readLegacy)).toEqual({ migrated: 0, skipped: 0, failed: 0 });
    expect((await openSessionLog("t1")).entries()).toHaveLength(1);
  });

  test("nothing to do on a fresh install", async () => {
    expect(await migrateSessions(readLegacy)).toEqual({ migrated: 0, skipped: 0, failed: 0 });
  });

  test("one corrupt session does not stop the pass, and keeps its file for a retry", async () => {
    // Taking the boot down over one unreadable conversation is by far the worse failure.
    await mkdir(SESSIONS_DIR, { recursive: true });
    await writeFile(join(SESSIONS_DIR, "broken.json"), "{ not json", "utf-8");
    await writeLegacy(data("t1", [userMsg("q", 1)]));

    expect(await migrateSessions(readLegacy)).toEqual({ migrated: 1, skipped: 0, failed: 1 });
    expect((await openSessionLog("t1")).entries()).toHaveLength(1);
    expect(await readFile(join(SESSIONS_DIR, "broken.json"), "utf-8")).toBe("{ not json");
  });

  test("the settings survive and the run state does not", async () => {
    // scopeOverride, scopeEffort and invokedBy are set from the job before each run, and a cron
    // session outlives its run: a persisted copy would outlive the settings it was taken from.
    await writeLegacy(data("t1", [userMsg("q", 1)], {
      title: "mon fil", modelOverride: "opus-5", approvedTools: ["bash"], verbose: true, pinRank: 0,
      scopeOverride: { tools: ["bash"] }, scopeEffort: "high", invokedBy: "other",
    } as Partial<LegacySessionData>));
    await migrateSessions(readLegacy);

    const meta = await readMeta("t1");
    expect(meta).toMatchObject({ title: "mon fil", modelOverride: "opus-5", approvedTools: ["bash"], verbose: true, pinRank: 0 });
    const raw = JSON.parse(await readFile(metaPath("t1"), "utf-8")) as Record<string, unknown>;
    expect(raw["scopeOverride"]).toBeUndefined();
    expect(raw["scopeEffort"]).toBeUndefined();
    expect(raw["invokedBy"]).toBeUndefined();
    // And neither is the conversation: that is the split the whole change exists for.
    expect(raw["messages"]).toBeUndefined();
    expect(raw["promptBase"]).toBeUndefined();
  });

  test("the journals are folded into the log, once", async () => {
    await writeLegacy(data("t1", [userMsg("q", 1), assistantMsg("a", 5)], {
      commands: [{ input: "/status", output: "ok", timestamp: at(2) }],
      failures: [{ error: "boom", timestamp: at(3) }],
    }));
    await migrateSessions(readLegacy);
    const entries = (await openSessionLog("t1")).entries();
    expect(entries.map((e) => e.type)).toEqual(["user", "command", "failure", "phase"]);
  });

  test("a compacted conversation keeps a boundary that points at a real entry", async () => {
    const summary = { role: "user", content: "[Prior context summarized]\nresume\n\n[End of summary — respond to the message below]", timestamp: at(3), summaryOf: 2 } as SessionMessage;
    await writeLegacy(data("t1", [userMsg("vieux", 1), assistantMsg("vieux 2", 2), summary, userMsg("garde", 4)], { promptBase: 2 }));
    await migrateSessions(readLegacy);

    const log = await openSessionLog("t1");
    const entries = log.entries();
    const boundary = entries.find((e) => e.type === "compaction");
    expect(boundary).toBeDefined();
    // A dangling id would silently send the whole branch instead of the summarised prompt.
    expect(entries.some((e) => e.id === (boundary as { firstKeptEntryId: string }).firstKeptEntryId)).toBe(true);
    expect(promptOf(entries, log.leaf()).map((m) => m.content)).toEqual([expect.stringContaining("resume"), "garde"]);
  });

  test("the migrated log is a chain, and reopening it gives the same leaf", async () => {
    await writeLegacy(data("t1", [userMsg("q", 1), assistantMsg("a", 2), userMsg("q2", 3)]));
    await migrateSessions(readLegacy);

    const log = await openSessionLog("t1");
    const entries = log.entries();
    expect(entries[0]!.parentId).toBeNull();
    for (let i = 1; i < entries.length; i++) expect(entries[i]!.parentId).toBe(entries[i - 1]!.id);
    const meta = await readMeta("t1");
    expect(meta!.leafId).toBe(entries[entries.length - 1]!.id);
  });

  test("an empty conversation migrates to an empty log, not to nothing", async () => {
    // A thread created and never used still has a title and a workspace worth keeping.
    await writeLegacy(data("t1", [], { title: "vide" }));
    expect(await migrateSessions(readLegacy)).toEqual({ migrated: 1, skipped: 0, failed: 0 });
    expect((await openSessionLog("t1")).entries()).toEqual([]);
    expect(await readMeta("t1")).toMatchObject({ title: "vide", leafId: null });
  });
});

describe("readMeta", () => {
  test("a directory written by a newer binary is refused, never read optimistically", async () => {
    // Reading a shape you do not know and writing it back is how a downgrade drops fields.
    await mkdir(sessionDir("t1"), { recursive: true });
    await writeFile(metaPath("t1"), JSON.stringify({ id: "t1", storageVersion: STORAGE_VERSION + 1 }), "utf-8");
    await expect(readMeta("t1")).rejects.toBeInstanceOf(UnsupportedStorageVersionError);
  });

  test("no directory is no settings, not an error", async () => {
    expect(await readMeta("never-written")).toBeNull();
  });

  test("an unreadable file is treated as absent rather than fatal", async () => {
    await mkdir(sessionDir("t1"), { recursive: true });
    await writeFile(metaPath("t1"), "{ not json", "utf-8");
    expect(await readMeta("t1")).toBeNull();
  });
});

/**
 * `metaOf` rebuilds the settings from the session, so anything written into the file by someone
 * else is erased by the next persist unless it is carried across. Measured on 0.4.57: one persist
 * after a `/fork` dropped `forkedFrom` and every named branch, so branch bookkeeping survived
 * exactly until the next turn.
 */
describe("metaOf keeps what the session does not own", () => {
  test("a fork origin, its named branches and its undo state survive a persist", () => {
    const session = data("my-claw-app/thread/eve/conv", []);
    const previous = {
      ...metaOf(session, "e1"),
      forkedFrom: { sessionId: "my-claw-app/thread/eve/other", entryId: "e9" },
      branches: [{ leafId: "e1", label: "essai", ts: 1 }],
      undo: { redoLeafId: "e2", expectedLeafId: "e1" },
    };

    const rewritten = metaOf({ ...session, title: "renommee" }, "e2", previous);

    expect(rewritten.forkedFrom).toEqual({ sessionId: "my-claw-app/thread/eve/other", entryId: "e9" });
    expect(rewritten.branches).toHaveLength(1);
    expect(rewritten.undo).toEqual({ redoLeafId: "e2", expectedLeafId: "e1" });
    // And the session still owns its own half.
    expect(rewritten.title).toBe("renommee");
    expect(rewritten.leafId).toBe("e2");
  });

  test("a settings field the owner cleared is really cleared, not resurrected from the old file", () => {
    const session = data("my-claw-app/thread/eve/conv", []);
    const previous = metaOf({ ...session, title: "ancien", pinRank: 3 }, "e1");

    const rewritten = metaOf(session, "e1", previous);

    expect(rewritten.title).toBeUndefined();
    expect(rewritten.pinRank).toBeUndefined();
  });
});

/**
 * `persist` keeps rewriting a flat file beside every migrated directory, so offering it again meant
 * `alreadyMigrated` answered "yes" and the pass counted a skip for it on every boot, for as long as
 * the conversation existed. Measured on a copy of a real install: `skipped: 10`, forever.
 */
describe("a legacy file beside its own migrated directory is not work to do", () => {
  test("it is not offered, so nothing is skipped for it", async () => {
    const id = "my-claw-app/thread/frank/conv";
    await mkdir(sessionDir(id), { recursive: true });
    await writeFile(entriesPath(id), `{"id":"e1","seq":1,"ts":1,"type":"user","text":"hi","prompt":true}\n`, "utf-8");
    await writeFile(metaPath(id), JSON.stringify({
      id, platform: "my-claw-app", chatType: "dm", createdAt: at(0), lastActiveAt: at(0),
      storageVersion: STORAGE_VERSION, leafId: "e1",
    }), "utf-8");
    // What persist leaves beside it.
    await writeFile(join(SESSIONS_DIR, "my-claw-app", "thread", "frank", "conv.json"),
      JSON.stringify({ id, platform: "my-claw-app", chatType: "dm", createdAt: at(0), lastActiveAt: at(0), messages: [] }), "utf-8");

    expect(await legacySessionIds()).toEqual([]);
    expect(await migrateSessions(async () => null)).toEqual({ migrated: 0, skipped: 0, failed: 0 });
  });

  test("a legacy file with no directory of its own is still work to do", async () => {
    await writeLegacy(data("my-claw-app/thread/gina/conv", []));
    expect(await legacySessionIds()).toEqual(["my-claw-app/thread/gina/conv"]);
  });
});
