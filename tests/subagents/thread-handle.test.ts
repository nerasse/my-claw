import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { MY_CLAW_DIR } from "../../src/core/config.ts";
import {
  subagentSessionToThread,
  subagentThreadToSession,
  cronSessionToThread,
  saveSession,
  deleteSession,
  pruneOldSessions,
  type SessionData,
} from "../../src/sessions/store.ts";
import { SessionManager } from "../../src/sessions/manager.ts";

const SUBAGENT_DIR = join(MY_CLAW_DIR, "sessions", "subagent");

function session(id: string): SessionData {
  return {
    id,
    platform: "telegram",
    chatType: "dm",
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    messages: [],
    meta: {
      displayName: id.slice("subagent/".length).replace(/-[0-9a-f]{4}$/, ""),
      type: "research",
      parentSessionId: "my-claw-app/thread/owner/main",
      visibility: "global",
      createdAt: new Date().toISOString(),
    },
  };
}

test("a handle is ascii, short, and accepted by the channel's thread id rule", () => {
  const THREAD_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
  for (const name of ["research", "調査", "recherche-é", "a".repeat(64)]) {
    const handle = subagentSessionToThread(`subagent/${name}-a1b2`);
    assert.ok(handle, `no handle for ${name}`);
    assert.match(handle, THREAD_ID_PATTERN);
    assert.match(handle, /^sub-[0-9a-f]{16}$/);
  }
});

test("a handle is stable and distinguishes two agents sharing a suffix", () => {
  const a = subagentSessionToThread("subagent/research-a1b2");
  const b = subagentSessionToThread("subagent/writer-a1b2");
  assert.equal(a, subagentSessionToThread("subagent/research-a1b2"));
  assert.notEqual(a, b);
});

test("only a sub-agent session yields a handle", () => {
  assert.equal(subagentSessionToThread("my-claw-app/thread/owner/main"), null);
  assert.equal(subagentSessionToThread("cron/0123456789ab/17"), null);
  // And the two handle namespaces cannot be confused for one another.
  assert.notEqual(cronSessionToThread("cron/0123456789ab/17"), subagentSessionToThread("subagent/x-a1b2"));
});

test("a handle round-trips through the directory, including a hostile name", async () => {
  await mkdir(SUBAGENT_DIR, { recursive: true });
  const ids = ["subagent/research-a1b2", "subagent/調査-c3d4", "subagent/writer-a1b2"];
  try {
    for (const id of ids) await saveSession(id, session(id));
    for (const id of ids) {
      const handle = subagentSessionToThread(id)!;
      assert.equal(subagentThreadToSession(handle), id);
    }
  } finally {
    for (const id of ids) await deleteSession(id).catch(() => {});
  }
});

test("a handle for an agent that is gone resolves to nothing", async () => {
  const id = "subagent/vanished-9f9f";
  await saveSession(id, session(id));
  const handle = subagentSessionToThread(id)!;
  assert.equal(subagentThreadToSession(handle), id);
  await deleteSession(id);
  assert.equal(subagentThreadToSession(handle), null);
});

test("a malformed handle is rejected without touching the directory", () => {
  for (const bad of ["sub-", "sub-xyz", "sub-0123456789abcdef0", "sub_0123456789abcdef", "research-a1b2", ""]) {
    assert.equal(subagentThreadToSession(bad), null);
  }
});

test("resolveSessionId maps a handle to the sub-agent, and a stale one to an empty conversation", async () => {
  const id = "subagent/mapped-1a2b";
  await saveSession(id, session(id));
  try {
    const handle = subagentSessionToThread(id)!;
    const resolved = SessionManager.resolveSessionId("my-claw-app", "dm", "owner", "owner", {
      threadId: handle,
      sessionScope: "per-user",
    });
    assert.equal(resolved, id);

    // A handle that matches nothing must read as an empty conversation of its own, never as
    // another owner's thread.
    const stale = SessionManager.resolveSessionId("my-claw-app", "dm", "owner", "owner", {
      threadId: "sub-00000000deadbeef",
      sessionScope: "per-user",
    });
    assert.equal(stale, "my-claw-app/thread/owner/sub-00000000deadbeef");
  } finally {
    await deleteSession(id);
  }
});

test("a normal conversation thread is untouched by the sub-agent branch", () => {
  const resolved = SessionManager.resolveSessionId("my-claw-app", "dm", "owner", "owner", {
    threadId: "abc123",
    sessionScope: "per-user",
  });
  assert.equal(resolved, "my-claw-app/thread/owner/abc123");
});

test("a named sub-agent survives the 30-day prune that still sweeps a chat platform", async () => {
  const stale = Date.now() - 40 * 86_400_000;
  await mkdir(SUBAGENT_DIR, { recursive: true });
  await mkdir(join(MY_CLAW_DIR, "sessions", "telegram"), { recursive: true });

  const keep = join(SUBAGENT_DIR, "old-agent-b1b1.json");
  const sweep = join(MY_CLAW_DIR, "sessions", "telegram", "dm-someone.json");
  await writeFile(keep, JSON.stringify(session("subagent/old-agent-b1b1")));
  await writeFile(sweep, JSON.stringify({ id: "telegram/dm/someone", messages: [] }));
  const { utimesSync } = await import("node:fs");
  utimesSync(keep, stale / 1000, stale / 1000);
  utimesSync(sweep, stale / 1000, stale / 1000);

  try {
    await pruneOldSessions();
    assert.equal(await Bun.file(keep).exists(), true, "a named sub-agent must not be swept");
    assert.equal(await Bun.file(sweep).exists(), false, "the exemption must stay scoped");
  } finally {
    await rm(keep, { force: true });
    await rm(sweep, { force: true });
  }
});
