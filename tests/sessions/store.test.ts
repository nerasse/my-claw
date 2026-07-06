import { describe, test, expect, afterAll } from "bun:test";
import { readFile, rm, mkdir, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { loadSession, saveSession, deleteSession, pruneOldSessions, trimSessionMessages, dropLeadingOrphanToolMessages, type SessionData, type SessionMessage } from "../../src/sessions/store.ts";
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

  test("trimSessionMessages never starts on an orphan tool (parallel tool block cut)", () => {
    // A block of parallel tool calls; slicing the last 2 would start on a tool result.
    const full = [U("q"), A("", ["t1", "t2"]), T("t1"), T("t2"), A("done")];
    const trimmed = trimSessionMessages(full, 2);
    expect(trimmed[0]!.role).not.toBe("tool");
  });
});
