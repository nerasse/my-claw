import { describe, test, expect, afterAll } from "bun:test";
import { readFile, rm, mkdir, writeFile, stat, utimes } from "node:fs/promises";
import { join, dirname } from "node:path";
import { loadSession, saveSession, deleteSession, pruneOldSessions, listSessionIdsByPrefix, dropLeadingOrphanToolMessages, type SessionData, type SessionMessage } from "../../src/sessions/store.ts";
import { MY_CLAW_DIR } from "../../src/core/config.ts";

const SESSIONS_DIR = join(MY_CLAW_DIR, "sessions");

function makeSession(id: string): SessionData {
  return {
    id,
    platform: "telegram",
    chatType: "dm",
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    messages: [
      { role: "user", content: "hello", timestamp: new Date().toISOString() },
      { role: "assistant", content: "hi", timestamp: new Date().toISOString() },
    ],
  };
}

const TEST_IDS = [
  "test-store-roundtrip",
  "test-store-overwrite",
  "test-store-delete",
  "test-store-missing",
  "test-store-traversal",
  "test-store-atomic",
  "test-store-unicode",
];

afterAll(async () => {
  for (const id of TEST_IDS) {
    const safe = id.replace(/\.\./g, "_").replace(/\0/g, "");
    const path = join(SESSIONS_DIR, `${safe}.json`);
    await rm(path, { force: true }).catch(() => {});
    await rm(path + ".tmp", { force: true }).catch(() => {});
  }
});

describe("session pruning", () => {
  test("sweeps stale chat-platform sessions but never app conversations", async () => {
    const staleAt = new Date(Date.now() - 60 * 86_400_000);
    const telegramPath = join(SESSIONS_DIR, "telegram", "dm", "prune-victim.json");
    const appPath = join(SESSIONS_DIR, "my-claw-app", "thread", "owner", "prune-keeper.json");

    for (const path of [telegramPath, appPath]) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify(makeSession("prune")), "utf-8");
      await utimes(path, staleAt, staleAt);
    }

    await pruneOldSessions();

    expect(await stat(telegramPath).catch(() => null)).toBeNull();
    // The app drawer lists this very file: a quiet month must not erase a named conversation.
    expect(await stat(appPath).catch(() => null)).not.toBeNull();

    await rm(join(SESSIONS_DIR, "telegram"), { recursive: true, force: true }).catch(() => {});
    await rm(join(SESSIONS_DIR, "my-claw-app"), { recursive: true, force: true }).catch(() => {});
  });
});

describe("session store", () => {
  test("save and load round-trip preserves data", async () => {
    const session = makeSession("test-store-roundtrip");
    session.modelOverride = "gpt-4";
    session.tokenUsage = { promptTokens: 100, completionTokens: 50, totalTokens: 150, apiCalls: 3 };

    await saveSession("test-store-roundtrip", session);
    const loaded = await loadSession("test-store-roundtrip");

    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe("test-store-roundtrip");
    expect(loaded!.platform).toBe("telegram");
    expect(loaded!.messages.length).toBe(2);
    expect(loaded!.modelOverride).toBe("gpt-4");
    expect(loaded!.tokenUsage?.totalTokens).toBe(150);
    expect(loaded!.tokenUsage?.apiCalls).toBe(3);
  });

  test("save overwrites existing session", async () => {
    const session1 = makeSession("test-store-overwrite");
    session1.messages = [{ role: "user", content: "first", timestamp: new Date().toISOString() }];
    await saveSession("test-store-overwrite", session1);

    const session2 = makeSession("test-store-overwrite");
    session2.messages = [
      { role: "user", content: "second", timestamp: new Date().toISOString() },
      { role: "assistant", content: "reply", timestamp: new Date().toISOString() },
    ];
    await saveSession("test-store-overwrite", session2);

    const loaded = await loadSession("test-store-overwrite");
    expect(loaded!.messages.length).toBe(2);
    expect(loaded!.messages[0]!.content).toBe("second");
  });

  test("delete removes session file", async () => {
    await saveSession("test-store-delete", makeSession("test-store-delete"));
    const before = await loadSession("test-store-delete");
    expect(before).not.toBeNull();

    await deleteSession("test-store-delete");
    const after = await loadSession("test-store-delete");
    expect(after).toBeNull();
  });

  test("delete removes the empty parent directory of a nested session id", async () => {
    await saveSession("cron/job-abc/run-1", makeSession("cron/job-abc/run-1"));
    const dir = join(SESSIONS_DIR, "cron", "job-abc");
    expect(await stat(dir).then(() => true).catch(() => false)).toBe(true);

    await deleteSession("cron/job-abc/run-1");
    expect(await stat(dir).then(() => true).catch(() => false)).toBe(false);
  });

  test("delete keeps a parent directory that still holds siblings", async () => {
    await saveSession("cron/job-def/run-1", makeSession("cron/job-def/run-1"));
    await saveSession("cron/job-def/run-2", makeSession("cron/job-def/run-2"));

    await deleteSession("cron/job-def/run-1");
    const dir = join(SESSIONS_DIR, "cron", "job-def");
    expect(await stat(dir).then(() => true).catch(() => false)).toBe(true);
    expect(await loadSession("cron/job-def/run-2")).not.toBeNull();
    await deleteSession("cron/job-def/run-2");
  });

  test("load returns null for missing session", async () => {
    const result = await loadSession("test-store-missing");
    expect(result).toBeNull();
  });

  test("sanitizeSessionId prevents path traversal", async () => {
    const session = makeSession("test-store-traversal");
    await saveSession("../../etc/test-store-traversal", session);
    // Sanitizer replaces .. with _ — file lands in sessions/_/_/etc/ not /etc/
    const safe = "_/_/etc/test-store-traversal";
    const path = join(SESSIONS_DIR, `${safe}.json`);
    const exists = await stat(path).then(() => true).catch(() => false);
    expect(exists).toBe(true);
    // Verify it's NOT at the traversal target
    const badPath = "/etc/test-store-traversal.json";
    const badExists = await stat(badPath).then(() => true).catch(() => false);
    expect(badExists).toBe(false);
    // Clean up
    await rm(path, { force: true }).catch(() => {});
    await rm(join(SESSIONS_DIR, "_"), { recursive: true, force: true }).catch(() => {});
  });

  test("atomic write uses tmp file", async () => {
    const session = makeSession("test-store-atomic");
    await saveSession("test-store-atomic", session);
    // Verify no .tmp file remains
    const tmpPath = join(SESSIONS_DIR, "test-store-atomic.json.tmp");
    const tmpExists = await stat(tmpPath).then(() => true).catch(() => false);
    expect(tmpExists).toBe(false);

    // Verify the actual file has valid JSON
    const raw = await readFile(join(SESSIONS_DIR, "test-store-atomic.json"), "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.id).toBe("test-store-atomic");
  });

  test("session with unicode ID works", async () => {
    const session = makeSession("test-store-unicode");
    await saveSession("test-store-unicode", session);
    const loaded = await loadSession("test-store-unicode");
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe("test-store-unicode");
  });

  test("session with tool messages round-trips correctly", async () => {
    const session = makeSession("test-store-roundtrip");
    session.messages = [
      { role: "user", content: "do something", timestamp: new Date().toISOString() },
      { role: "assistant", content: "", timestamp: new Date().toISOString(), toolCalls: [{ id: "tc1", name: "bash", arguments: '{"command":"ls"}' }] },
      { role: "tool", toolCallId: "tc1", content: "file1.txt\nfile2.txt", timestamp: new Date().toISOString() },
      { role: "assistant", content: "Found two files.", timestamp: new Date().toISOString() },
    ];
    await saveSession("test-store-roundtrip", session);
    const loaded = await loadSession("test-store-roundtrip");
    expect(loaded!.messages.length).toBe(4);
    const toolMsg = loaded!.messages[2]!;
    expect(toolMsg.role).toBe("tool");
    if (toolMsg.role === "tool") {
      expect(toolMsg.toolCallId).toBe("tc1");
      expect(toolMsg.content).toContain("file1.txt");
    }
  });

  test("delete non-existent session does not throw", async () => {
    await deleteSession("does-not-exist-at-all-" + Date.now());
  });
});

describe("trim boundary repair (orphan tool messages)", () => {
  const ts = new Date().toISOString();
  const U = (c: string): SessionMessage => ({ role: "user", content: c, timestamp: ts });
  const A = (c: string, ids?: string[]): SessionMessage => ({ role: "assistant", content: c, timestamp: ts, ...(ids ? { toolCalls: ids.map((id) => ({ id, name: "x", arguments: "{}" })) } : {}) });
  const T = (id: string): SessionMessage => ({ role: "tool", toolCallId: id, content: "res", timestamp: ts });

  test("dropLeadingOrphanToolMessages strips leading tool messages", () => {
    const out = dropLeadingOrphanToolMessages([T("a"), T("b"), U("hi"), A("ok")]);
    expect(out.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  test("keeps a clean head untouched", () => {
    const msgs = [U("hi"), A("ok")];
    expect(dropLeadingOrphanToolMessages(msgs)).toBe(msgs);
  });

  test("a window cut inside a parallel tool block never starts on an orphan tool", () => {
    // A block of parallel tool calls; slicing the last 2 would start on a tool result.
    const full = [U("q"), A("", ["t1", "t2"]), T("t1"), T("t2"), A("done")];
    const trimmed = dropLeadingOrphanToolMessages(full.slice(-2));
    expect(trimmed[0]!.role).not.toBe("tool");
  });
});

/**
 * The storage switch made a session a directory. Both halves of "find a session on disk" had to
 * learn that, and one of them did not: the walk kept looking for `*.json`, so the only thing left
 * to find inside a migrated conversation was its own `meta.json`.
 */
describe("a migrated session is a directory, not a file", () => {
  const OWNER_PREFIX = "my-claw-app/thread/scan-owner/";
  const OWNER_DIR = join(SESSIONS_DIR, "my-claw-app", "thread", "scan-owner");
  const CRON_DIR = join(SESSIONS_DIR, "cron", "scan-job");

  async function writeMigrated(dir: string, meta: Record<string, unknown>): Promise<void> {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "entries.jsonl"), `{"id":"e1","seq":1,"ts":1,"type":"user","text":"hi","prompt":true}\n`, "utf-8");
    await writeFile(join(dir, "meta.json"), JSON.stringify({ storageVersion: 1, leafId: "e1", ...meta }), "utf-8");
  }

  afterAll(async () => {
    await rm(join(SESSIONS_DIR, "my-claw-app"), { recursive: true, force: true }).catch(() => {});
    await rm(join(SESSIONS_DIR, "cron"), { recursive: true, force: true }).catch(() => {});
  });

  test("listing yields the conversation, never its meta file", async () => {
    await writeMigrated(join(OWNER_DIR, "thread-a"), { id: `${OWNER_PREFIX}thread-a`, platform: "my-claw-app", chatType: "dm", createdAt: "x", lastActiveAt: "x" });

    const ids = await listSessionIdsByPrefix(OWNER_PREFIX, Number.MAX_SAFE_INTEGER);

    expect(ids).toEqual([`${OWNER_PREFIX}thread-a`]);
    // The ghost the drawer used to show: a threadId of "meta", one per real conversation.
    expect(ids.some((id) => id.endsWith("/meta"))).toBe(false);
  });

  test("the walk stops at a session, so nothing inside it reads as a conversation", async () => {
    const dir = join(OWNER_DIR, "thread-b");
    await writeMigrated(dir, { id: `${OWNER_PREFIX}thread-b`, platform: "my-claw-app", chatType: "dm", createdAt: "x", lastActiveAt: "x" });
    // A spilled tool output, and the empty directory the broken listing itself created.
    await mkdir(join(dir, "tool-output"), { recursive: true });
    await writeFile(join(dir, "tool-output", "spill.json"), "{}", "utf-8");
    await mkdir(join(dir, "meta"), { recursive: true });

    const ids = await listSessionIdsByPrefix(`${OWNER_PREFIX}thread-b`, Number.MAX_SAFE_INTEGER);

    expect(ids).toEqual([`${OWNER_PREFIX}thread-b`]);
  });

  test("a session that is both shapes at once is listed once", async () => {
    const id = `${OWNER_PREFIX}thread-c`;
    await writeMigrated(join(OWNER_DIR, "thread-c"), { id, platform: "my-claw-app", chatType: "dm", createdAt: "x", lastActiveAt: "x" });
    // What `persist` still writes beside the directory.
    await writeFile(join(OWNER_DIR, "thread-c.json"), JSON.stringify({ ...makeSession(id), messages: [] }), "utf-8");

    const ids = await listSessionIdsByPrefix(`${OWNER_PREFIX}thread-c`, Number.MAX_SAFE_INTEGER);

    expect(ids).toEqual([id]);
  });

  test("loading a migrated session returns its settings, not a blank one", async () => {
    const id = `${OWNER_PREFIX}thread-d`;
    await writeMigrated(join(OWNER_DIR, "thread-d"), {
      id,
      platform: "my-claw-app",
      chatType: "dm",
      createdAt: "2026-08-01T00:00:00.000Z",
      lastActiveAt: "2026-08-02T00:00:00.000Z",
      title: "the one with the audit",
      modelOverride: "anthropic/claude-opus-5",
      contextOverride: 512000,
      workspace: "dev",
    });

    const session = await loadSession(id);

    // Without this, the conversation reopens as a new one and the next persist writes the
    // defaults over meta.json: same entries, no title, no model, no window.
    expect(session).not.toBeNull();
    expect(session!.title).toBe("the one with the audit");
    expect(session!.modelOverride).toBe("anthropic/claude-opus-5");
    expect(session!.contextOverride).toBe(512000);
    expect(session!.workspace).toBe("dev");
    expect(session!.messages).toEqual([]);
    // Directory bookkeeping is not part of the session.
    expect(session as unknown as Record<string, unknown>).not.toHaveProperty("storageVersion");
    expect(session as unknown as Record<string, unknown>).not.toHaveProperty("leafId");
  });

  test("pruning a stale session takes the whole directory, not just its settings", async () => {
    const dir = join(CRON_DIR, "stale-run");
    await writeMigrated(dir, { id: "cron/scan-job/stale-run", platform: "cron", chatType: "dm", createdAt: "x", lastActiveAt: "x" });
    const staleAt = new Date(Date.now() - 60 * 86_400_000);
    for (const name of ["entries.jsonl", "meta.json"]) {
      await utimes(join(dir, name), staleAt, staleAt);
    }

    await pruneOldSessions();

    // The old sweep deleted `meta.json` alone and left the log: listed, but unopenable.
    expect(await stat(join(dir, "entries.jsonl")).catch(() => null)).toBeNull();
    expect(await stat(dir).catch(() => null)).toBeNull();
  });
});

/**
 * The crash loop of 0.4.55, reproduced.
 *
 * An empty conversation migrated to a directory with settings and no log. Every walk keyed on the
 * log alone, so all of them read it as "not a session": the listing offered `<id>/meta`, `peek`
 * loaded the parsed `meta.json` as if it were a session, and the first `.length` on its absent
 * `messages` took the process down. Pinning a thread was enough to trigger it.
 */
describe("an empty conversation is still a session", () => {
  const PREFIX = "my-claw-app/thread/empty-owner/";
  const DIR = join(SESSIONS_DIR, "my-claw-app", "thread", "empty-owner");

  afterAll(async () => {
    await rm(join(SESSIONS_DIR, "my-claw-app"), { recursive: true, force: true }).catch(() => {});
  });

  /** What the migration wrote for a session whose `messages` was empty: no `entries.jsonl`. */
  async function writeSettingsOnly(threadId: string): Promise<void> {
    const dir = join(DIR, threadId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "meta.json"), JSON.stringify({
      id: `${PREFIX}${threadId}`,
      platform: "my-claw-app",
      chatType: "dm",
      createdAt: "2026-08-25T10:58:03.681Z",
      lastActiveAt: "2026-08-25T10:58:03.681Z",
      storageVersion: 1,
      leafId: null,
    }), "utf-8");
  }

  test("a directory with settings and no log lists as itself, not as its meta", async () => {
    await writeSettingsOnly("thread-empty");

    const ids = await listSessionIdsByPrefix(PREFIX, Number.MAX_SAFE_INTEGER);

    expect(ids).toEqual([`${PREFIX}thread-empty`]);
  });

  test("loading a settings file as a session refuses instead of crashing the caller", async () => {
    await writeSettingsOnly("thread-refuse");

    // The id the broken listing handed to `peek`. `cache()` then read `.messages.length` on it.
    const ghost = await loadSession(`${PREFIX}thread-refuse/meta`);

    expect(ghost).toBeNull();
  });

  test("a session that does load always has messages to count", async () => {
    await writeSettingsOnly("thread-count");

    const session = await loadSession(`${PREFIX}thread-count`);

    // `SessionManager.cache` does exactly this, and it must never throw.
    expect(session).not.toBeNull();
    expect(session!.messages.length).toBe(0);
  });
});

/**
 * `<owner>/meta.json` is a session *file* that happens to be named like a settings file. Writing
 * in the ghost conversation 0.4.53 offered persisted exactly that, one directory above the
 * conversations, so a rule of "a directory holding meta.json is a session" read the owner's own
 * directory as one conversation and hid every real one inside it.
 */
describe("a session file named meta.json does not make its directory a session", () => {
  const OWNER = "my-claw-app/thread/bob";
  const DIR = join(SESSIONS_DIR, "my-claw-app", "thread", "bob");

  afterAll(async () => {
    await rm(join(SESSIONS_DIR, "my-claw-app"), { recursive: true, force: true }).catch(() => {});
  });

  test("the owner's conversations survive a conversation called meta", async () => {
    for (const name of ["conv-a", "conv-b"]) {
      await mkdir(join(DIR, name), { recursive: true });
      await writeFile(join(DIR, name, "entries.jsonl"), `{"id":"e1","seq":1,"ts":1,"type":"user","text":"hi","prompt":true}\n`, "utf-8");
      await writeFile(join(DIR, name, "meta.json"), JSON.stringify({ id: `${OWNER}/${name}`, platform: "my-claw-app", chatType: "dm", createdAt: "x", lastActiveAt: "x", storageVersion: 1, leafId: "e1" }), "utf-8");
    }
    // What the click persisted: a real session, with a real turn in it, named `meta`.
    await writeFile(join(DIR, "meta.json"), JSON.stringify(makeSession(`${OWNER}/meta`)), "utf-8");

    const ids = await listSessionIdsByPrefix(OWNER, Number.MAX_SAFE_INTEGER);

    expect(ids.sort()).toEqual([`${OWNER}/conv-a`, `${OWNER}/conv-b`, `${OWNER}/meta`]);
  });
});
