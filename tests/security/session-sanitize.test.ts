import { test } from "bun:test";
import assert from "node:assert/strict";
import { saveSession, loadSession, deleteSession } from "../../src/sessions/store.ts";
import type { SessionData } from "../../src/sessions/store.ts";

function makeSession(id: string): SessionData {
  return {
    id,
    platform: "test",
    chatType: "direct",
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    messages: [],
  };
}

test("session: normal ID round-trips through save/load", async () => {
  const id = `test/sanitize-normal-${Date.now()}`;
  const session = makeSession(id);
  try {
    await saveSession(id, session);
    const loaded = await loadSession(id);
    assert.ok(loaded);
    assert.equal(loaded.id, id);
    assert.equal(loaded.platform, "test");
  } finally {
    await deleteSession(id);
  }
});

test("session: ID with '..' is sanitized and round-trips", async () => {
  const id = `test/../escape-${Date.now()}`;
  const session = makeSession(id);
  try {
    await saveSession(id, session);
    const loaded = await loadSession(id);
    assert.ok(loaded, "session with '..' ID should be loadable via the same ID");
    assert.equal(loaded.id, id);
  } finally {
    await deleteSession(id);
  }
});

test("session: ID with null byte is sanitized and round-trips", async () => {
  const id = `test/null\x00byte-${Date.now()}`;
  const session = makeSession(id);
  try {
    await saveSession(id, session);
    const loaded = await loadSession(id);
    assert.ok(loaded, "session with null byte ID should be loadable via the same ID");
    assert.equal(loaded.id, id);
  } finally {
    await deleteSession(id);
  }
});
