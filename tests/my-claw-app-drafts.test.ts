import { test, describe, beforeEach, afterEach } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DraftStore, DRAFT_TEXT_LIMIT } from "../src/channels/my-claw-app/drafts.ts";
import { hooks } from "../src/hooks/index.ts";
import { deleteSession, type LegacySessionData } from "../src/sessions/store.ts";
import { writeLegacySessionFile } from "./helpers/session-log.ts";

const OWNER = "dev-drafts";

function sessionIdFor(thread: string): string {
  return `my-claw-app/thread/${OWNER}/${thread}`;
}

function session(id: string): LegacySessionData {
  return {
    id,
    platform: "my-claw-app",
    chatType: "dm",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastActiveAt: "2026-01-01T00:01:00.000Z",
    messages: [],
  };
}

describe("DraftStore", () => {
  let path: string;
  let store: DraftStore;

  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), "drafts-"));
    path = join(dir, "drafts.json");
    store = new DraftStore(path);
  });

  afterEach(() => {
    store.close();
  });

  test("stores a draft, reads it back, and clears on empty text", async () => {
    const id = sessionIdFor("t1");
    assert.equal((await store.set(id, "un debut de phrase")).changed, true);
    assert.equal(await store.textOf(id), "un debut de phrase");

    assert.equal((await store.set(id, "")).changed, true);
    assert.equal(await store.textOf(id), "");
    assert.equal((await store.set(id, "")).changed, false, "clearing nothing changes nothing");
  });

  test("an unchanged text reports no change, so nothing is written or broadcast", async () => {
    const id = sessionIdFor("t1");
    await store.set(id, "meme texte");
    const second = await store.set(id, "meme texte");
    assert.equal(second.changed, false);
    // The timestamp is the first write's: a reconnecting device re-sending its draft must not
    // look like a newer edit than the draft another window is holding.
    assert.equal(second.ts, (await store.set(id, "meme texte")).ts);
  });

  test("a draft over the wire limit is ignored, and does not destroy the one already stored", async () => {
    const id = sessionIdFor("t1");
    await store.set(id, "court");
    const write = await store.set(id, "x".repeat(DRAFT_TEXT_LIMIT + 1));
    assert.equal(write.changed, false);
    assert.equal(await store.textOf(id), "court");
  });

  test("the newest 200 survive, the oldest are dropped", async () => {
    for (let i = 0; i < 205; i += 1) await store.set(sessionIdFor(`t${i}`), `draft ${i}`);
    const drafted = await store.drafted();
    assert.equal(drafted.size, 200);
    assert.equal(drafted.has(sessionIdFor("t0")), false);
    assert.equal(drafted.has(sessionIdFor("t204")), true);
  });

  test("what was flushed is what a fresh store reads back", async () => {
    const id = sessionIdFor("t1");
    await writeLegacySessionFile(id, session(id));
    try {
      await store.set(id, "survit au redemarrage");
      await store.flush();

      const reopened = new DraftStore(path);
      try {
        assert.equal(await reopened.textOf(id), "survit au redemarrage");
      } finally {
        reopened.close();
      }
    } finally {
      await deleteSession(id);
    }
  });

  test("deleting a conversation takes its draft with it", async () => {
    const kept = sessionIdFor("kept");
    const doomed = sessionIdFor("doomed");
    await store.set(kept, "a garder");
    await store.set(doomed, "a jeter");

    hooks.emit("session:deleted", { sessionId: doomed });

    assert.equal(await store.textOf(doomed), "");
    assert.equal(await store.textOf(kept), "a garder");
  });

  test("a closed store no longer listens: the hook cannot reach it", async () => {
    const id = sessionIdFor("t1");
    await store.set(id, "texte");
    store.close();

    hooks.emit("session:deleted", { sessionId: id });

    assert.equal(await store.textOf(id), "texte");
  });

  test("the boot sweep drops an orphan older than the ttl and keeps a live conversation", async () => {
    const live = sessionIdFor("live");
    const orphan = sessionIdFor("orphan");
    await writeLegacySessionFile(live, session(live));
    try {
      const old = Date.now() - 8 * 24 * 60 * 60 * 1000;
      const seeded = { version: 1, drafts: { [live]: { text: "vivant", ts: old }, [orphan]: { text: "orphelin", ts: old } } };
      await Bun.write(path, JSON.stringify(seeded));

      const reopened = new DraftStore(path);
      try {
        assert.equal(await reopened.textOf(live), "vivant");
        assert.equal(await reopened.textOf(orphan), "", "no session file and older than the ttl");
      } finally {
        reopened.close();
      }
    } finally {
      await deleteSession(live);
    }
  });

  test("a draft on a thread with no session yet survives a restart", async () => {
    // The first message of a brand new conversation is written before any session exists. Sweeping
    // on "no session file" alone threw exactly that draft away, which is the case this store is
    // most worth having for.
    const unborn = sessionIdFor("unborn");
    const seeded = { version: 1, drafts: { [unborn]: { text: "premier message", ts: Date.now() } } };
    await Bun.write(path, JSON.stringify(seeded));

    const reopened = new DraftStore(path);
    try {
      assert.equal(await reopened.textOf(unborn), "premier message");
    } finally {
      reopened.close();
    }
  });

  test("an unreadable file starts empty instead of throwing", async () => {
    await Bun.write(path, "{ not json");
    const reopened = new DraftStore(path);
    try {
      assert.equal((await reopened.drafted()).size, 0);
      assert.equal((await reopened.set(sessionIdFor("t1"), "quand meme")).changed, true);
    } finally {
      reopened.close();
    }
  });

  test("a flush with nothing pending writes nothing new", async () => {
    const id = sessionIdFor("t1");
    await store.set(id, "un texte");
    await store.flush();
    const first = await readFile(path, "utf-8");

    await store.set(id, "un texte");
    await store.flush();

    assert.equal(await readFile(path, "utf-8"), first);
  });
});

describe("DraftStore files", () => {
  let path: string;
  let store: DraftStore;

  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), "drafts-files-"));
    path = join(dir, "drafts.json");
    store = new DraftStore(path);
  });

  afterEach(() => {
    store.close();
  });

  test("a file with no text is still a draft", async () => {
    const id = sessionIdFor("t-files");
    assert.equal(await store.addFile(id, { id: "media-1" }), true);
    assert.equal(await store.textOf(id), "");
    assert.deepEqual((await store.filesOf(id)).map((file) => file.id), ["media-1"]);
    assert.equal((await store.drafted()).has(id), true, "the drawer's bit counts files");
  });

  test("the same file twice is one chip", async () => {
    const id = sessionIdFor("t-files");
    await store.addFile(id, { id: "media-1" });
    assert.equal(await store.addFile(id, { id: "media-1" }), false);
    assert.equal((await store.filesOf(id)).length, 1);
  });

  test("emptying the text keeps the files", async () => {
    const id = sessionIdFor("t-files");
    await store.set(id, "avec une photo");
    await store.addFile(id, { id: "media-1" });
    await store.set(id, "");
    assert.equal(await store.textOf(id), "");
    assert.deepEqual((await store.filesOf(id)).map((file) => file.id), ["media-1"]);
  });

  test("removing the last file of a textless draft drops the entry", async () => {
    const id = sessionIdFor("t-files");
    await store.addFile(id, { id: "media-1" });
    assert.equal(await store.removeFile(id, "media-1"), true);
    assert.equal((await store.drafted()).has(id), false);
  });

  test("a send takes the files it carried and leaves the others", async () => {
    const id = sessionIdFor("t-files");
    await store.addFile(id, { id: "sent" });
    await store.addFile(id, { id: "staged-elsewhere" });
    assert.equal(await store.removeFiles(id, ["sent"]), true);
    assert.deepEqual((await store.filesOf(id)).map((file) => file.id), ["staged-elsewhere"]);
    assert.equal(await store.removeFiles(id, ["never-there"]), false);
  });

  test("files survive a restart, and a voice note keeps its flag", async () => {
    const id = sessionIdFor("t-files");
    await store.addFile(id, { id: "voice-1", audioAsVoice: true, durationMs: 4200 });
    await store.flush();
    store.close();

    const reopened = new DraftStore(path);
    try {
      const files = await reopened.filesOf(id);
      assert.deepEqual(files.map((file) => [file.id, file.audioAsVoice, file.durationMs]), [["voice-1", true, 4200]]);
    } finally {
      reopened.close();
    }
  });

  test("the session:deleted hook takes the staged files with it", async () => {
    const id = sessionIdFor("t-deleted");
    await store.addFile(id, { id: "media-1" });
    hooks.emit("session:deleted", { sessionId: id });
    assert.equal((await store.drafted()).has(id), false);
  });
});
