import { test, describe, beforeEach } from "bun:test";
import assert from "node:assert/strict";
import { SessionManager } from "../src/sessions/manager.ts";
import { saveSession, deleteSession, loadSession, type SessionData } from "../src/sessions/store.ts";
import { MAX_TITLE_LENGTH, MyClawAppSessionStoreImpl } from "../src/channels/my-claw-app/sessions.ts";
import { SessionFileStore, filePathFor, filesDirFor } from "../src/channels/my-claw-app/files.ts";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const DEVICE = "dev-test";
const THREAD = "thread-1";

function session(id: string, messages: SessionData["messages"]): SessionData {
  return {
    id,
    platform: "my-claw-app",
    chatType: "dm",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastActiveAt: "2026-01-01T00:01:00.000Z",
    messages,
  };
}

describe("MyClawAppSessionStoreImpl.history", () => {
  let store: MyClawAppSessionStoreImpl;
  let sessionId: string;

  beforeEach(async () => {
    store = new MyClawAppSessionStoreImpl(new SessionManager(), new SessionFileStore());
    sessionId = store.resolveSessionId(DEVICE, THREAD);
    await deleteSession(sessionId);
  });

  test("replays tool calls as structured cards with output and duration", async () => {
    await saveSession(sessionId, session(sessionId, [
      { role: "user", content: "check le site", timestamp: "2026-01-01T00:00:01.000Z" },
      {
        role: "assistant",
        content: "je regarde",
        timestamp: "2026-01-01T00:00:02.000Z",
        toolCalls: [{ id: "call-1", name: "fetch", arguments: '{"url":"https://x.dev"}', durationMs: 412 }],
      },
      { role: "tool", toolCallId: "call-1", content: "HTTP 200 OK", timestamp: "2026-01-01T00:00:03.000Z" },
      { role: "assistant", content: "le site repond", timestamp: "2026-01-01T00:00:04.000Z" },
    ]));

    const entries = await store.history(DEVICE, THREAD);
    assert.deepEqual(entries.map((e) => e.role), ["user", "assistant", "tool", "assistant"]);

    const card = entries[2]!;
    assert.equal(card.role, "tool");
    if (card.role !== "tool") throw new Error("expected a tool entry");
    assert.equal(card.name, "fetch");
    assert.deepEqual(card.args, { url: "https://x.dev" });
    assert.equal(card.durationMs, 412);
    assert.equal(card.output, "HTTP 200 OK");
    assert.equal(card.truncated, false);
  });

  test("keeps the card when the timing predates duration persistence and truncates long output", async () => {
    await saveSession(sessionId, session(sessionId, [
      {
        role: "assistant",
        content: "",
        timestamp: "2026-01-01T00:00:02.000Z",
        toolCalls: [{ id: "call-2", name: "bash", arguments: "not json" }],
      },
      { role: "tool", toolCallId: "call-2", content: "z".repeat(5000), timestamp: "2026-01-01T00:00:03.000Z" },
    ]));

    const entries = await store.history(DEVICE, THREAD);
    assert.equal(entries.length, 1);
    const card = entries[0]!;
    if (card.role !== "tool") throw new Error("expected a tool entry");
    assert.equal(card.durationMs, undefined);
    assert.deepEqual(card.args, { raw: "not json" });
    assert.equal(card.output.length, 4000);
    assert.equal(card.truncated, true);
  });
  test("a replayed turn carries its attachments and not the server paths", async () => {
    const files = new SessionFileStore();
    const saved = await files.save(DEVICE, THREAD, "photo de vacances.png", new Uint8Array([1, 2, 3]));
    const gone = await files.save(DEVICE, THREAD, "notes.md", new Uint8Array([4]));
    await files.remove(DEVICE, THREAD, gone.id);

    await saveSession(sessionId, session(sessionId, [
      {
        role: "user",
        content: `regarde ca\n\n[Attachments]\n- image: ${filePathFor(DEVICE, THREAD, saved.storedName)} (image/png, 3 bytes, ${saved.filename}, 800x600)\n- file: ${filePathFor(DEVICE, THREAD, gone.storedName)} (text/markdown, 1 bytes, ${gone.filename})`,
        timestamp: "2026-01-01T00:00:01.000Z",
      },
    ]));

    const entries = await store.history(DEVICE, THREAD);
    assert.equal(entries.length, 1);
    const turn = entries[0]!;
    if (turn.role !== "user") throw new Error("expected a user entry");
    assert.equal(turn.text, "regarde ca");
    assert.equal(turn.attachments?.length, 2);

    const [image, missing] = turn.attachments!;
    assert.equal(image!.id, saved.id);
    assert.equal(image!.type, "image");
    assert.equal(image!.filename, "photo de vacances.png");
    assert.equal(image!.sizeBytes, 3);
    assert.equal(image!.deleted, undefined);

    // Deleted since: still named in the bubble, but flagged so the app opens nothing.
    assert.equal(missing!.id, gone.id);
    assert.equal(missing!.filename, "notes.md");
    assert.equal(missing!.deleted, true);
  });

  test("a replayed voice note carries its duration and its transcript, not the [Audio] marker", async () => {
    const files = new SessionFileStore();
    const saved = await files.save(DEVICE, THREAD, "voice-note.m4a", new Uint8Array([1, 2, 3, 4]));

    await saveSession(sessionId, session(sessionId, [
      {
        role: "user",
        content: `[Audio]: "rappelle-moi demain"\n\n[Attachments]\n- audio: ${filePathFor(DEVICE, THREAD, saved.storedName)} (audio/mp4, 4 bytes, ${saved.filename}, 3100 ms)`,
        timestamp: "2026-01-01T00:00:01.000Z",
      },
    ]));

    const entries = await store.history(DEVICE, THREAD);
    const turn = entries[0]!;
    if (turn.role !== "user") throw new Error("expected a user entry");

    // The bubble reads the same as when it was sent: a player, and the words under it.
    assert.equal(turn.text, "");
    assert.deepEqual(turn.transcripts, { [saved.id]: "rappelle-moi demain" });
    assert.equal(turn.attachments?.length, 1);
    assert.equal(turn.attachments![0]!.type, "audio");
    // Without this the replayed player would show 0:00 where the live one showed 0:03.
    assert.equal(turn.attachments![0]!.durationMs, 3100);
  });

  test("several recordings in one turn each keep their own words", async () => {
    const files = new SessionFileStore();
    const first = await files.save(DEVICE, THREAD, "one.m4a", new Uint8Array([1]));
    const second = await files.save(DEVICE, THREAD, "two.m4a", new Uint8Array([2]));

    await saveSession(sessionId, session(sessionId, [
      {
        role: "user",
        content:
          `[Audio 1]: "premier bout"\n\n[Audio 2]: "deuxieme bout"\n\n[Attachments]\n` +
          `- audio: ${filePathFor(DEVICE, THREAD, first.storedName)} (1200 ms)\n` +
          `- audio: ${filePathFor(DEVICE, THREAD, second.storedName)} (2400 ms)`,
        timestamp: "2026-01-01T00:00:01.000Z",
      },
    ]));

    const turn = (await store.history(DEVICE, THREAD))[0]!;
    if (turn.role !== "user") throw new Error("expected a user entry");

    // Pairing by position: one blob repeated under both bubbles would say the wrong thing twice.
    assert.deepEqual(turn.transcripts, {
      [first.id]: "premier bout",
      [second.id]: "deuxieme bout",
    });
    assert.equal(turn.attachments?.[0]!.durationMs, 1200);
    assert.equal(turn.attachments?.[1]!.durationMs, 2400);
  });

  test("a caption sent with a voice note survives the transcript split", async () => {
    await saveSession(sessionId, session(sessionId, [
      { role: "user", content: `regarde ca\n\n[Audio]: "et ecoute"`, timestamp: "2026-01-01T00:00:01.000Z" },
    ]));

    const turn = (await store.history(DEVICE, THREAD))[0]!;
    if (turn.role !== "user") throw new Error("expected a user entry");
    assert.equal(turn.text, "regarde ca");
    // No attachment survives to pair it with, so there is nothing to hang the words on.
    assert.equal(turn.transcripts, undefined);
  });

  test("a failed transcription stays visible as text", async () => {
    await saveSession(sessionId, session(sessionId, [
      {
        role: "user",
        content: "[Audio]: [Transcription failed: timeout]",
        timestamp: "2026-01-01T00:00:01.000Z",
      },
    ]));

    const turn = (await store.history(DEVICE, THREAD))[0]!;
    if (turn.role !== "user") throw new Error("expected a user entry");
    // Hiding this would replay a voice note that silently said nothing.
    assert.equal(turn.text, "[Audio]: [Transcription failed: timeout]");
    assert.equal(turn.transcripts, undefined);
  });

  test("a renamed conversation keeps its name in the list, and can be handed back", async () => {
    await saveSession(sessionId, session(sessionId, [
      { role: "user", content: "comment je configure le dns du serveur", timestamp: "2026-01-01T00:00:01.000Z" },
    ]));

    // Without a name, the list shows how the thread opened rather than what it is about.
    let listed = await store.list(DEVICE);
    assert.equal(listed[0]!.title, "comment je configure le dns du serveur");

    await store.rename(DEVICE, THREAD, "  Infra   maison  ");
    listed = await store.list(DEVICE);
    assert.equal(listed[0]!.title, "Infra maison");

    // Blank is not a name: the conversation goes back to its automatic title.
    await store.rename(DEVICE, THREAD, "   ");
    listed = await store.list(DEVICE);
    assert.equal(listed[0]!.title, "comment je configure le dns du serveur");
  });

  test("archiving files the conversation away whole, and unarchiving hands it back", async () => {
    await saveSession(sessionId, session(sessionId, [
      { role: "user", content: "premier message", timestamp: "2026-01-01T00:00:01.000Z" },
      { role: "assistant", content: "bien recu", timestamp: "2026-01-01T00:00:02.000Z" },
    ]));
    await store.rename(DEVICE, THREAD, "Infra maison");

    await store.archive(DEVICE, THREAD);

    let listed = await store.list(DEVICE);
    assert.equal(listed[0]!.archived, true);
    // Nothing is moved or dropped: name, turns and count all survive the filing.
    assert.equal(listed[0]!.title, "Infra maison");
    assert.equal(listed[0]!.messageCount, 2);
    assert.equal((await store.history(DEVICE, THREAD)).length, 2);

    await store.unarchive(DEVICE, THREAD);

    listed = await store.list(DEVICE);
    assert.equal(listed[0]!.archived, undefined);
    assert.equal(listed[0]!.title, "Infra maison");
    assert.equal((await store.history(DEVICE, THREAD)).length, 2);
  });

  test("archiving a conversation that was never opened is refused, not invented", async () => {
    await assert.rejects(() => store.archive(DEVICE, "jamais-ouvert"));
    const listed = await store.list(DEVICE);
    assert.equal(listed.some((entry) => entry.threadId === "jamais-ouvert"), false);
  });

  test("an over-long name is cut to what the drawer can show", async () => {
    await saveSession(sessionId, session(sessionId, [
      { role: "user", content: "x", timestamp: "2026-01-01T00:00:01.000Z" },
    ]));
    await store.rename(DEVICE, THREAD, "n".repeat(200));

    const listed = await store.list(DEVICE);
    assert.equal(listed[0]!.title.length, MAX_TITLE_LENGTH);
  });

  test("renaming a conversation that was never opened is refused, not invented", async () => {
    await assert.rejects(() => store.rename(DEVICE, "jamais-ouvert", "Fantome"));
    const listed = await store.list(DEVICE);
    assert.equal(listed.some((entry) => entry.threadId === "jamais-ouvert"), false);
  });

  test("a turn that merely mentions [Attachments] keeps its text whole", async () => {
    await saveSession(sessionId, session(sessionId, [
      { role: "user", content: "le format [Attachments]\nc'est quoi", timestamp: "2026-01-01T00:00:01.000Z" },
    ]));

    const entries = await store.history(DEVICE, THREAD);
    const turn = entries[0]!;
    if (turn.role !== "user") throw new Error("expected a user entry");
    assert.equal(turn.text, "le format [Attachments]\nc'est quoi");
    assert.equal(turn.attachments, undefined);
  });

  test("an assistant MEDIA: ref replays as its stored attachment, not the temp path", async () => {
    const files = new SessionFileStore();
    const saved = await files.save(DEVICE, THREAD, "test-image.jpg", new Uint8Array([1]));
    const gone = await files.save(DEVICE, THREAD, "notes.md", new Uint8Array([2]));
    await files.remove(DEVICE, THREAD, gone.id);

    await saveSession(sessionId, session(sessionId, [
      {
        role: "assistant",
        content: "Voilà, un chat random d'Unsplash 🐱\n\nMEDIA:/tmp/test-image.jpg",
        timestamp: "2026-01-01T00:00:01.000Z",
      },
    ]));

    const turn = (await store.history(DEVICE, THREAD))[0]!;
    if (turn.role !== "assistant") throw new Error("expected an assistant entry");
    // The bubble reads like the live message: the caption, not the path the agent wrote.
    assert.equal(turn.text, "Voilà, un chat random d'Unsplash 🐱");
    assert.equal(turn.attachments?.length, 1);
    assert.equal(turn.attachments![0]!.id, saved.id);
    assert.equal(turn.attachments![0]!.type, "image");
    assert.equal(turn.attachments![0]!.mimeType, "image/jpeg");
    assert.equal(turn.attachments![0]!.filename, "test-image.jpg");
    assert.equal(turn.attachments![0]!.deleted, undefined);
  });

  test("an assistant MEDIA: ref whose copy is gone replays flagged, never as dead text", async () => {
    await saveSession(sessionId, session(sessionId, [
      {
        role: "assistant",
        content: "MEDIA:/tmp/gone.png",
        timestamp: "2026-01-01T00:00:01.000Z",
      },
    ]));

    const turn = (await store.history(DEVICE, THREAD))[0]!;
    if (turn.role !== "assistant") throw new Error("expected an assistant entry");
    assert.equal(turn.text, "");
    assert.equal(turn.attachments?.length, 1);
    assert.equal(turn.attachments![0]!.type, "image");
    assert.equal(turn.attachments![0]!.filename, "gone.png");
    assert.equal(turn.attachments![0]!.deleted, true);
  });

  test("several MEDIA: refs in one turn each pair with their own stored copy", async () => {
    const files = new SessionFileStore();
    const first = await files.save(DEVICE, THREAD, "a.jpg", new Uint8Array([1]));
    const second = await files.save(DEVICE, THREAD, "b.jpg", new Uint8Array([2]));

    await saveSession(sessionId, session(sessionId, [
      {
        role: "assistant",
        content: "voici\n\nMEDIA:/tmp/a.jpg\n\nMEDIA:/tmp/b.jpg",
        timestamp: "2026-01-01T00:00:01.000Z",
      },
    ]));

    const turn = (await store.history(DEVICE, THREAD))[0]!;
    if (turn.role !== "assistant") throw new Error("expected an assistant entry");
    assert.equal(turn.attachments?.length, 2);
    const ids = turn.attachments!.map((a) => a.id);
    assert.deepEqual(ids.sort(), [first.id, second.id].sort());
  });

  // docs/reasoning-visibility.md: the reasoning is persisted so a reopened conversation can still
  // show what the model thought, collapsed.
  test("a replayed turn carries the reasoning the model produced", async () => {
    await saveSession(sessionId, session(sessionId, [
      { role: "user", content: "9.11 ou 9.8 ?", timestamp: "2026-01-01T00:00:01.000Z" },
      {
        role: "assistant",
        content: "9.11",
        timestamp: "2026-01-01T00:00:02.000Z",
        reasoning: "comparing the decimal parts",
      },
    ]));

    const turn = (await store.history(DEVICE, THREAD))[1]!;
    if (turn.role !== "assistant") throw new Error("expected an assistant entry");
    assert.equal(turn.reasoning, "comparing the decimal parts");
  });

  test("a turn that produced no reasoning replays without the field", async () => {
    await saveSession(sessionId, session(sessionId, [
      { role: "assistant", content: "plain answer", timestamp: "2026-01-01T00:00:01.000Z" },
    ]));

    const turn = (await store.history(DEVICE, THREAD))[0]!;
    if (turn.role !== "assistant") throw new Error("expected an assistant entry");
    assert.equal("reasoning" in turn, false);
  });
});

describe("SessionFileStore naming", () => {
  test("keeps the uploaded name on disk and still lists pre-naming entries", async () => {
    const files = new SessionFileStore();
    const saved = await files.save(DEVICE, "naming", "rapport final (v2).pdf", new Uint8Array([1]));
    assert.equal(saved.filename, "rapport final (v2).pdf");
    assert.equal(saved.storedName, `${saved.id}__rapport final (v2).pdf`);
    assert.equal(saved.mimeType, "application/pdf");

    // Written before the name was persisted: listed under its id rather than dropped.
    const legacyId = "11111111-2222-3333-4444-555555555555";
    await writeFile(join(filesDirFor(DEVICE, "naming"), `${legacyId}.png`), new Uint8Array([2]));

    const listed = await files.list(DEVICE, "naming");
    const byId = new Map(listed.map((f) => [f.id, f]));
    assert.equal(byId.get(saved.id)!.filename, "rapport final (v2).pdf");
    assert.equal(byId.get(legacyId)!.filename, `${legacyId}.png`);
    assert.equal(byId.get(legacyId)!.type, "image");

    // Read and delete address the entry through its stored name, not the display one.
    assert.ok((await files.read(DEVICE, "naming", saved.id))!.path.endsWith("(v2).pdf"));
    assert.equal(await files.remove(DEVICE, "naming", saved.id), true);
    assert.equal(await files.findById(DEVICE, "naming", saved.id), null);
  });
});


describe("MyClawAppSessionStoreImpl.remove cascade", () => {
  let store: MyClawAppSessionStoreImpl;
  let sessionId: string;

  beforeEach(async () => {
    sessionId = `my-claw-app/thread/${DEVICE}/${THREAD}`;
    await deleteSession(sessionId);
  });

  test("removing a conversation hands its session id to the cascade hook", async () => {
    const seen: string[] = [];
    store = new MyClawAppSessionStoreImpl(new SessionManager(), new SessionFileStore(), async (id) => {
      seen.push(id);
    });
    await saveSession(sessionId, session(sessionId, []));
    await store.remove(DEVICE, THREAD);

    assert.deepEqual(seen, [sessionId]);
    assert.equal(await loadSession(sessionId), null);
  });

  test("the hook runs after the conversation is gone, so a cascade sees a dead parent", async () => {
    const order: string[] = [];
    store = new MyClawAppSessionStoreImpl(new SessionManager(), new SessionFileStore(), async () => {
      order.push("cascade");
    });
    await saveSession(sessionId, session(sessionId, []));
    await store.remove(DEVICE, THREAD);
    order.push("after");
    assert.deepEqual(order, ["cascade", "after"]);
  });

  test("without a hook, removing still works", async () => {
    store = new MyClawAppSessionStoreImpl(new SessionManager(), new SessionFileStore());
    await saveSession(sessionId, session(sessionId, []));
    await store.remove(DEVICE, THREAD);
    assert.equal(await loadSession(sessionId), null);
  });
});

describe("MyClawAppSessionStoreImpl.setWorkspace", () => {
  let manager: SessionManager;
  let store: MyClawAppSessionStoreImpl;
  let sessionId: string;

  beforeEach(async () => {
    manager = new SessionManager();
    store = new MyClawAppSessionStoreImpl(
      manager,
      new SessionFileStore(),
      undefined,
      (key) => key === "default" || key === "sofa",
    );
    sessionId = `my-claw-app/thread/${DEVICE}/${THREAD}`;
    await deleteSession(sessionId);
  });

  test("creates the conversation eagerly with the chosen workspace", async () => {
    await store.setWorkspace(DEVICE, THREAD, "sofa");
    const session = await manager.peek(sessionId);
    assert.ok(session);
    assert.equal(session.workspace, "sofa");
    assert.equal((await loadSession(sessionId))?.workspace, "sofa");
  });

  test("switches an existing conversation and persists the change", async () => {
    await store.setWorkspace(DEVICE, THREAD, "sofa");
    await store.setWorkspace(DEVICE, THREAD, "default");
    const session = await manager.peek(sessionId);
    assert.equal(session?.workspace, undefined);
    assert.equal((await loadSession(sessionId))?.workspace, undefined);
  });

  test("refuses an unknown workspace key without creating anything", async () => {
    await assert.rejects(() => store.setWorkspace(DEVICE, THREAD, "mars"), /unknown workspace/);
    assert.equal(await manager.peek(sessionId), null);
  });

  test("lists the stored workspace on every summary", async () => {
    await store.setWorkspace(DEVICE, THREAD, "sofa");
    const summaries = await store.list(DEVICE);
    assert.equal(summaries[0]!.workspace, "sofa");
    await store.setWorkspace(DEVICE, THREAD, "default");
    const after = await store.list(DEVICE);
    assert.equal(after[0]!.workspace, "default");
  });
});
