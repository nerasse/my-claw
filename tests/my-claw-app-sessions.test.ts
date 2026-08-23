import { test, describe, beforeEach, afterEach } from "bun:test";
import assert from "node:assert/strict";
import { SessionManager } from "../src/sessions/manager.ts";
import { saveSession, deleteSession, loadSession, FAILURE_TEXT_LIMIT, type SessionData } from "../src/sessions/store.ts";
import { MAX_TITLE_LENGTH, MyClawAppSessionStoreImpl } from "../src/channels/my-claw-app/sessions.ts";
import { SessionFileStore, filePathFor, filesDirFor } from "../src/channels/my-claw-app/files.ts";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { DraftStore } from "../src/channels/my-claw-app/drafts.ts";
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

  /**
   * Reported from the app: a thread that had been compacted came back as a wall of
   * `[Prior context summarized]` in the owner's own voice, because a summary is stored in a `user`
   * turn -- the role the prompt needs it in. It is a boundary, and the turns it covers are still
   * above it.
   */
  test("a compaction summary is replayed as a boundary, not as something the owner typed", async () => {
    await saveSession(sessionId, session(sessionId, [
      { role: "user", content: "premiere question", timestamp: "2026-01-01T00:00:01.000Z" },
      { role: "assistant", content: "premiere reponse", timestamp: "2026-01-01T00:00:02.000Z" },
      {
        role: "user",
        content: "[Prior context summarized]\nPrior work: the two turns above.\n\n[End of summary — respond to the message below]",
        timestamp: "2026-01-01T00:00:03.000Z",
        summaryOf: 2,
      },
      { role: "user", content: "la suite", timestamp: "2026-01-01T00:00:04.000Z" },
    ]));

    const { entries } = await store.history(DEVICE, THREAD);
    // Nothing is hidden: the turns the summary stands for are replayed in full above it.
    assert.deepEqual(entries.map((e) => e.role), ["user", "assistant", "user", "user"]);

    const boundary = entries[2]!;
    if (boundary.role === "tool") throw new Error("expected a text entry");
    assert.equal(boundary.summaryOf, 2);
    // The scaffolding is addressed to the model: "respond to the message below" has no reader here.
    assert.equal(boundary.text, "Prior work: the two turns above.");

    const ordinary = entries[3]!;
    if (ordinary.role === "tool") throw new Error("expected a text entry");
    assert.equal(ordinary.summaryOf, undefined);
    assert.equal(ordinary.text, "la suite");
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

    const { entries } = await store.history(DEVICE, THREAD);
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

  /**
   * Our own tools reach the Claude SDK through an in-process MCP server, so the SDK calls them
   * `mcp__myclaw__bash` and the mirror kept that name. A reopened thread then showed the
   * plumbing on every card while the live cards, built from the registry, showed `bash`.
   */
  test("a replayed card names the tool, not the MCP wrapper the SDK wraps it in", async () => {
    await saveSession(sessionId, session(sessionId, [
      {
        role: "assistant",
        content: "",
        timestamp: "2026-01-01T00:00:02.000Z",
        toolCalls: [
          { id: "call-3", name: "mcp__myclaw__bash", arguments: '{"command":"ls"}', durationMs: 12 },
          // A real MCP server's tool keeps its prefix: that is what says where it comes from.
          { id: "call-4", name: "mcp__mailcow__get_status", arguments: "{}", durationMs: 8 },
        ],
      },
      { role: "tool", toolCallId: "call-3", content: "AGENTS.md", timestamp: "2026-01-01T00:00:03.000Z" },
      { role: "tool", toolCallId: "call-4", content: "ok", timestamp: "2026-01-01T00:00:04.000Z" },
    ]));

    const { entries } = await store.history(DEVICE, THREAD);
    const names = entries.filter((e) => e.role === "tool").map((e) => (e.role === "tool" ? e.name : ""));
    assert.deepEqual(names, ["bash", "mcp__mailcow__get_status"]);
  });

  test("pages backwards through a long conversation without repeating or dropping a turn", async () => {
    const messages: SessionData["messages"] = [];
    for (let i = 0; i < 12; i++) {
      messages.push({ role: "user", content: `q${i}`, timestamp: `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z` });
    }
    await saveSession(sessionId, session(sessionId, messages));

    const newest = await store.history(DEVICE, THREAD, 5);
    assert.deepEqual(newest.entries.map((e) => (e.role === "tool" ? e.name : e.text)), ["q7", "q8", "q9", "q10", "q11"]);
    assert.equal(newest.hasMore, true);

    const older = await store.history(DEVICE, THREAD, 5, 5);
    assert.deepEqual(older.entries.map((e) => (e.role === "tool" ? e.name : e.text)), ["q2", "q3", "q4", "q5", "q6"]);
    assert.equal(older.hasMore, true);

    // The last page is short and says so: the app must stop asking rather than loop on empties.
    const oldest = await store.history(DEVICE, THREAD, 5, 10);
    assert.deepEqual(oldest.entries.map((e) => (e.role === "tool" ? e.name : e.text)), ["q0", "q1"]);
    assert.equal(oldest.hasMore, false);
  });

  /**
   * One agentic turn is easily fifty tool results. Counted flat, the newest page began inside
   * the work and the question that started it sat on the page above: the owner saw his own
   * message vanish from a thread he had just written in.
   */
  test("a page starts at a turn, so a long turn never pushes its own question off the screen", async () => {
    const messages: SessionData["messages"] = [
      { role: "user", content: "la question", timestamp: "2026-01-01T00:00:00.000Z" },
    ];
    for (let i = 1; i <= 8; i++) {
      messages.push({ role: "assistant", content: `a${i}`, timestamp: `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z` });
    }
    await saveSession(sessionId, session(sessionId, messages));

    const page = await store.history(DEVICE, THREAD, 5);
    assert.equal(page.entries[0]?.role, "user");
    assert.equal(page.entries[0]?.role === "user" ? page.entries[0].text : "", "la question");
    assert.equal(page.entries.length, 9, "the page grew to the start of the turn");
    assert.equal(page.hasMore, false);
  });

  test("the walk back is bounded: only a pathological turn still starts mid-flight", async () => {
    const base = Date.parse("2026-01-01T00:00:00.000Z");
    const stamp = (i: number): string => new Date(base + i * 1000).toISOString();
    const messages: SessionData["messages"] = [{ role: "user", content: "la question", timestamp: stamp(0) }];
    for (let i = 1; i <= 450; i++) {
      messages.push({ role: "assistant", content: `a${i}`, timestamp: stamp(i) });
    }
    await saveSession(sessionId, session(sessionId, messages));

    const page = await store.history(DEVICE, THREAD, 5);
    // Five asked for, 405 taken: the walk stops 400 messages back and not one further.
    assert.equal(page.entries.length, 405);
    assert.equal(page.entries[0]?.role === "assistant" ? page.entries[0].text : "", "a46");
    assert.equal(page.hasMore, true);
    // The page above must still end where this one begins, or the walk would duplicate a turn.
    const older = await store.history(DEVICE, THREAD, 5, page.nextBefore);
    const last = older.entries.at(-1);
    assert.equal(last && last.role === "assistant" ? last.text : "", "a45");
  });

  /**
   * The app replaces the thread on screen with what this returns. Served from the file, a switch
   * to another conversation and back mid-run wiped the question and every card already streamed,
   * and a restart before the run ended made that permanent.
   */
  test("a turn in flight is part of the history, not something the file has yet", async () => {
    const manager = new SessionManager();
    const live = new MyClawAppSessionStoreImpl(manager, new SessionFileStore());
    await saveSession(sessionId, session(sessionId, [
      { role: "user", content: "tour precedent", timestamp: "2026-01-01T00:00:01.000Z" },
    ]));

    const cached = await manager.getOrCreateWithMeta(sessionId, "my-claw-app", "dm");
    cached.messages.push({ role: "user", content: "la question en cours", timestamp: "2026-01-01T00:00:02.000Z" });
    cached.messages.push({
      role: "assistant",
      content: "",
      timestamp: "2026-01-01T00:00:03.000Z",
      toolCalls: [{ id: "call-live", name: "bash", arguments: '{"command":"ls"}' }],
    });
    cached.messages.push({ role: "tool", toolCallId: "call-live", content: "README.md", timestamp: "2026-01-01T00:00:04.000Z" });

    const { entries } = await live.history(DEVICE, THREAD);
    assert.deepEqual(entries.map((e) => e.role), ["user", "user", "tool"]);
    assert.equal(entries[1]?.role === "user" ? entries[1].text : "", "la question en cours");
    const card = entries[2]!;
    assert.equal(card.role === "tool" ? card.output : "", "README.md");

    const summary = (await live.list(DEVICE)).find((s) => s.threadId === THREAD);
    assert.equal(summary?.messageCount, 4, "the drawer counts the turn being produced");
  });

  test("a tool call with no result yet rebuilds as still running, on the live card's own id", async () => {
    await saveSession(sessionId, session(sessionId, [
      { role: "user", content: "cherche", timestamp: "2026-01-01T00:00:01.000Z" },
      {
        role: "assistant",
        content: "",
        timestamp: "2026-01-01T00:00:02.000Z",
        // The assistant turn is persisted before its tools run, so a reload mid-call sees this.
        toolCalls: [
          { id: "call-done", name: "search", arguments: "{}", durationMs: 20 },
          { id: "call-inflight", name: "bash", arguments: '{"command":"sleep 600"}' },
        ],
      },
      { role: "tool", toolCallId: "call-done", content: "3 matches", timestamp: "2026-01-01T00:00:03.000Z" },
    ]));

    const { entries } = await store.history(DEVICE, THREAD);
    const cards = entries.filter((e) => e.role === "tool");
    assert.equal(cards.length, 2);

    const [done, inflight] = cards;
    assert.equal(done?.role === "tool" ? done.running : "absent", undefined, "a settled call is not running");
    assert.equal(done?.role === "tool" ? done.output : "", "3 matches");

    // Without this the card rebuilt as a finished, successful, empty-output call: the spinner was
    // gone and the run looked done while it was still going.
    assert.equal(inflight?.role === "tool" ? inflight.running : false, true);
    assert.equal(inflight?.role === "tool" ? inflight.output : "x", "");

    // Same id the live stream mints, so the finishing tool patches this card instead of appending
    // a second one beside it.
    assert.equal(inflight?.id, "t-call-inflight");
    assert.equal(done?.id, "t-call-done");
  });

  test("a cursor past the start of the session is an empty page, not an error", async () => {
    await saveSession(sessionId, session(sessionId, [
      { role: "user", content: "seul message", timestamp: "2026-01-01T00:00:01.000Z" },
    ]));

    const page = await store.history(DEVICE, THREAD, 50, 999);
    assert.deepEqual(page.entries, []);
    assert.equal(page.hasMore, false);
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

    const { entries } = await store.history(DEVICE, THREAD);
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

    const { entries } = await store.history(DEVICE, THREAD);
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

    const { entries } = await store.history(DEVICE, THREAD);
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

  test("a replayed location keeps structured data and hides the model-only block", async () => {
    const location = {
      latitude: 48.8566,
      longitude: 2.3522,
      accuracyMeters: 24,
      capturedAt: "2026-08-13T12:30:00.000Z",
      address: { formatted: "Rue de Rivoli, Paris", level: "street" as const, provider: "geoapify" as const },
    };
    await saveSession(sessionId, session(sessionId, [
      {
        role: "user",
        content: "Je suis ici\n\n[Shared location]\n- coordinates: 48.856600, 2.352200\n- accuracy: +/- 24 m\n- capturedAt: 2026-08-13T12:30:00.000Z\n- address (approximate, street, geoapify): Rue de Rivoli, Paris",
        timestamp: "2026-01-01T00:00:01.000Z",
        location,
      },
    ]));

    const turn = (await store.history(DEVICE, THREAD)).entries[0]!;
    if (turn.role !== "user") throw new Error("expected a user entry");
    assert.equal(turn.text, "Je suis ici");
    assert.deepEqual(turn.location, location);
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

    const turn = (await store.history(DEVICE, THREAD)).entries[0]!;
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

    const turn = (await store.history(DEVICE, THREAD)).entries[0]!;
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

    const turn = (await store.history(DEVICE, THREAD)).entries[0]!;
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
    assert.equal((await store.history(DEVICE, THREAD)).entries.length, 2);

    await store.unarchive(DEVICE, THREAD);

    listed = await store.list(DEVICE);
    assert.equal(listed[0]!.archived, undefined);
    assert.equal(listed[0]!.title, "Infra maison");
    assert.equal((await store.history(DEVICE, THREAD)).entries.length, 2);
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

    const { entries } = await store.history(DEVICE, THREAD);
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

    const turn = (await store.history(DEVICE, THREAD)).entries[0]!;
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

    const turn = (await store.history(DEVICE, THREAD)).entries[0]!;
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

    const turn = (await store.history(DEVICE, THREAD)).entries[0]!;
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

    const turn = (await store.history(DEVICE, THREAD)).entries[1]!;
    if (turn.role !== "assistant") throw new Error("expected an assistant entry");
    assert.equal(turn.reasoning, "comparing the decimal parts");
  });

  test("a turn that produced no reasoning replays without the field", async () => {
    await saveSession(sessionId, session(sessionId, [
      { role: "assistant", content: "plain answer", timestamp: "2026-01-01T00:00:01.000Z" },
    ]));

    const turn = (await store.history(DEVICE, THREAD)).entries[0]!;
    if (turn.role !== "assistant") throw new Error("expected an assistant entry");
    assert.equal("reasoning" in turn, false);
  });

  // A turn that thinks again mid-answer was streamed as two bubbles. Replaying it as one put every
  // thought above text it was not about -- docs/reasoning-visibility.md.
  test("a turn that thought twice replays as the two bubbles it was", async () => {
    await saveSession(sessionId, session(sessionId, [
      { role: "user", content: "et apres ?", timestamp: "2026-01-01T00:00:01.000Z" },
      {
        role: "assistant",
        content: "first answersecond answer",
        timestamp: "2026-01-01T00:00:02.000Z",
        reasoning: "first thoughtsecond thought",
        segments: [
          { reasoning: "first thought", content: "first answer" },
          { reasoning: "second thought", content: "second answer" },
        ],
      },
    ]));

    const { entries } = await store.history(DEVICE, THREAD);
    assert.equal(entries.length, 3);
    const [, first, second] = entries;
    if (first?.role !== "assistant" || second?.role !== "assistant") throw new Error("expected two assistant entries");
    assert.equal(first.text, "first answer");
    assert.equal(first.reasoning, "first thought");
    assert.equal(second.text, "second answer");
    assert.equal(second.reasoning, "second thought");
    assert.notEqual(first.id, second.id);
  });

  test("a last phase that only thought is kept, since the reader saw that bubble", async () => {
    await saveSession(sessionId, session(sessionId, [
      {
        role: "assistant",
        content: "answer",
        timestamp: "2026-01-01T00:00:02.000Z",
        reasoning: "answeringabout to call a tool",
        segments: [{ reasoning: "answering", content: "answer" }, { reasoning: "about to call a tool", content: "" }],
      },
    ]));

    const { entries } = await store.history(DEVICE, THREAD);
    assert.equal(entries.length, 2);
    const last = entries[1]!;
    if (last.role !== "assistant") throw new Error("expected an assistant entry");
    assert.equal(last.text, "");
    assert.equal(last.reasoning, "about to call a tool");
  });

  test("a thought with no answer at all still replays, instead of leaving a tool card alone", async () => {
    await saveSession(sessionId, session(sessionId, [
      {
        role: "assistant",
        content: "",
        timestamp: "2026-01-01T00:00:02.000Z",
        reasoning: "straight to the tool",
        toolCalls: [{ id: "c1", name: "bash", arguments: "{}" }],
      },
    ]));

    const { entries } = await store.history(DEVICE, THREAD);
    assert.equal(entries.length, 2);
    const thought = entries[0]!;
    if (thought.role !== "assistant") throw new Error("expected an assistant entry");
    assert.equal(thought.reasoning, "straight to the tool");
    assert.equal(entries[1]!.role, "tool");
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

describe("MyClawAppSessionStoreImpl pins", () => {
  let store: MyClawAppSessionStoreImpl;
  const threads = ["pin-a", "pin-b", "pin-c"];

  const ranksByThread = async (): Promise<Record<string, number | undefined>> => {
    const listed = await store.list(DEVICE);
    return Object.fromEntries(listed.map((entry) => [entry.threadId, entry.pinRank]));
  };

  beforeEach(async () => {
    store = new MyClawAppSessionStoreImpl(new SessionManager(), new SessionFileStore());
    for (const threadId of threads) {
      const sessionId = store.resolveSessionId(DEVICE, threadId);
      await deleteSession(sessionId);
      await saveSession(sessionId, session(sessionId, [
        { role: "user", content: threadId, timestamp: "2026-01-01T00:00:01.000Z" },
      ]));
    }
  });

  test("a pin is a rank in the listing, and pinning appends rather than displaces", async () => {
    await store.setPinned(DEVICE, "pin-a", true);
    await store.setPinned(DEVICE, "pin-b", true);

    assert.deepEqual(await ranksByThread(), { "pin-a": 0, "pin-b": 1, "pin-c": undefined });
  });

  test("pinning twice is not a second entry", async () => {
    await store.setPinned(DEVICE, "pin-a", true);
    await store.setPinned(DEVICE, "pin-a", true);
    await store.setPinned(DEVICE, "pin-b", true);

    assert.deepEqual(await ranksByThread(), { "pin-a": 0, "pin-b": 1, "pin-c": undefined });
  });

  test("unpinning renumbers the rest, so the next pin lands last instead of colliding", async () => {
    for (const threadId of threads) await store.setPinned(DEVICE, threadId, true);

    await store.setPinned(DEVICE, "pin-a", false);
    assert.deepEqual(await ranksByThread(), { "pin-a": undefined, "pin-b": 0, "pin-c": 1 });

    await store.setPinned(DEVICE, "pin-a", true);
    assert.deepEqual(await ranksByThread(), { "pin-a": 2, "pin-b": 0, "pin-c": 1 });
  });

  test("the dropped order is what is written down", async () => {
    for (const threadId of threads) await store.setPinned(DEVICE, threadId, true);

    await store.setPinOrder(DEVICE, ["pin-c", "pin-a", "pin-b"]);

    assert.deepEqual(await ranksByThread(), { "pin-a": 1, "pin-b": 2, "pin-c": 0 });
  });

  test("a reorder that ignores a pin made elsewhere keeps it, after the dragged ones", async () => {
    for (const threadId of threads) await store.setPinned(DEVICE, threadId, true);

    // The device dragged a list it had loaded before pin-c existed for it.
    await store.setPinOrder(DEVICE, ["pin-b", "pin-a"]);

    assert.deepEqual(await ranksByThread(), { "pin-a": 1, "pin-b": 0, "pin-c": 2 });
  });

  test("a reorder naming unknown or unpinned threads changes nothing about them", async () => {
    await store.setPinned(DEVICE, "pin-a", true);

    await store.setPinOrder(DEVICE, ["pin-c", "pin-a", "jamais-ouvert", "../escape"]);

    assert.deepEqual(await ranksByThread(), { "pin-a": 0, "pin-b": undefined, "pin-c": undefined });
  });

  test("pinning a conversation that was never opened is refused, not invented", async () => {
    await assert.rejects(() => store.setPinned(DEVICE, "jamais-ouvert", true));
    const listed = await store.list(DEVICE);
    assert.equal(listed.some((entry) => entry.threadId === "jamais-ouvert"), false);
  });

  test("an archived conversation keeps its pin, and its rank survives the round trip", async () => {
    await store.setPinned(DEVICE, "pin-a", true);
    await store.setPinned(DEVICE, "pin-b", true);

    await store.archive(DEVICE, "pin-a");
    assert.deepEqual(await ranksByThread(), { "pin-a": 0, "pin-b": 1, "pin-c": undefined });

    await store.unarchive(DEVICE, "pin-a");
    assert.deepEqual(await ranksByThread(), { "pin-a": 0, "pin-b": 1, "pin-c": undefined });
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

describe("MyClawAppSessionStoreImpl setInstructionPatch", () => {
  let manager: SessionManager;
  let store: MyClawAppSessionStoreImpl;
  let sessionId: string;

  beforeEach(async () => {
    manager = new SessionManager();
    store = new MyClawAppSessionStoreImpl(manager, new SessionFileStore());
    sessionId = `my-claw-app/thread/${DEVICE}/${THREAD}`;
    await deleteSession(sessionId);
    await saveSession(sessionId, session(sessionId, [{ role: "user", content: "hi", timestamp: "2026-01-01T00:00:01.000Z" }]));
  });

  test("nested.toggle disables and re-enables, persisted on the session", async () => {
    await store.setInstructionPatch(DEVICE, THREAD, { kind: "nested.toggle", path: "/repo/AGENTS.md" });
    assert.deepEqual((await manager.peek(sessionId))?.nestedDisabled, ["/repo/AGENTS.md"]);
    assert.deepEqual((await loadSession(sessionId))?.nestedDisabled, ["/repo/AGENTS.md"], "persisted");

    await store.setInstructionPatch(DEVICE, THREAD, { kind: "nested.toggle", path: "/repo/AGENTS.md", on: false });
    assert.equal((await manager.peek(sessionId))?.nestedDisabled, undefined);
    assert.equal((await loadSession(sessionId))?.nestedDisabled, undefined);
  });

  test("nested.unload purges the record without remembering the unload", async () => {
    const s = await manager.peek(sessionId);
    s!.nestedAgents = [{ path: "/repo/AGENTS.md", bytes: 10, firstAt: "2026-01-01T00:00:01.000Z", lastAt: "2026-01-01T00:00:01.000Z", count: 1 }];
    await manager.persist(sessionId);

    await store.setInstructionPatch(DEVICE, THREAD, { kind: "nested.unload", path: "/repo/AGENTS.md" });
    const after = await manager.peek(sessionId);
    assert.deepEqual(after?.nestedAgents, []);
    // An unload only purges the record: no flag is left behind, so the file can be
    // picked up again the next time a tool touches its directory.
    assert.equal((after as unknown as Record<string, unknown>)?.nestedUnloaded, undefined);
  });

  test("layer.toggle, skill.toggle and memory.toggle flip and persist", async () => {
    await store.setInstructionPatch(DEVICE, THREAD, { kind: "layer.toggle", layer: "tools" });
    await store.setInstructionPatch(DEVICE, THREAD, { kind: "skill.toggle", skill: "voice" });
    await store.setInstructionPatch(DEVICE, THREAD, { kind: "memory.toggle" });
    const s = await manager.peek(sessionId);
    assert.deepEqual(s?.promptLayersOff, ["tools"]);
    assert.deepEqual(s?.skillsOff, ["voice"]);
    assert.equal(s?.memoryRecallOff, true);
    assert.deepEqual((await loadSession(sessionId))?.promptLayersOff, ["tools"]);
  });

  test("refuses an unknown conversation", async () => {
    await assert.rejects(() => store.setInstructionPatch(DEVICE, "jamais", { kind: "memory.toggle" }), /no session/);
  });
});

describe("MyClawAppSessionStoreImpl command journal", () => {
  let manager: SessionManager;
  let store: MyClawAppSessionStoreImpl;
  let sessionId: string;

  beforeEach(async () => {
    manager = new SessionManager();
    store = new MyClawAppSessionStoreImpl(manager, new SessionFileStore());
    sessionId = store.resolveSessionId(DEVICE, THREAD);
    await deleteSession(sessionId);
  });

  test("a command and its answer survive a reload, outside the messages", async () => {
    await saveSession(sessionId, session(sessionId, [
      { role: "user", content: "salut", timestamp: "2026-01-01T00:00:01.000Z" },
      { role: "assistant", content: "salut", timestamp: "2026-01-01T00:00:02.000Z" },
    ]));
    await store.recordCommand(DEVICE, THREAD, "/compact", "Compacted 120 messages.", "summary text");

    const stored = await loadSession(sessionId);
    assert.equal(stored?.messages.length, 2, "the journal must never reach the prompt");
    assert.equal(stored?.commands?.length, 1);

    const { entries } = await store.history(DEVICE, THREAD);
    assert.deepEqual(entries.map((e) => e.role), ["user", "assistant", "user", "assistant"]);
    const answer = entries[3]!;
    if (answer.role === "tool") throw new Error("expected a text entry");
    assert.equal(entries[2]!.role === "tool" ? "" : entries[2]!.text, "/compact");
    assert.equal(answer.text, "Compacted 120 messages.");
    assert.equal(answer.command, true);
    assert.equal(answer.details, "summary text");
  });

  test("a command lands where it was typed, not at the end of the page", async () => {
    await saveSession(sessionId, session(sessionId, [
      { role: "user", content: "un", timestamp: "2026-01-01T00:00:01.000Z" },
      { role: "assistant", content: "deux", timestamp: "2026-01-01T00:00:09.000Z" },
    ]));
    const loaded = (await manager.peek(sessionId))!;
    loaded.commands = [
      { input: "/status", output: "context 12%", timestamp: "2026-01-01T00:00:05.000Z" },
    ];
    await manager.persist(sessionId);

    const { entries } = await store.history(DEVICE, THREAD);
    assert.deepEqual(entries.map((e) => (e.role === "tool" ? "tool" : e.text)), ["un", "/status", "context 12%", "deux"]);
  });

  test("each page carries its own commands, and only once", async () => {
    await saveSession(sessionId, session(sessionId, [
      { role: "user", content: "un", timestamp: "2026-01-01T00:00:01.000Z" },
      { role: "assistant", content: "deux", timestamp: "2026-01-01T00:00:02.000Z" },
      { role: "user", content: "trois", timestamp: "2026-01-01T00:00:10.000Z" },
      { role: "assistant", content: "quatre", timestamp: "2026-01-01T00:00:11.000Z" },
    ]));
    const loaded = (await manager.peek(sessionId))!;
    loaded.commands = [
      { input: "/stop", output: "Stopped.", timestamp: "2026-01-01T00:00:05.000Z" },
      { input: "/compact", output: "Compacted.", timestamp: "2026-01-01T00:00:20.000Z" },
    ];
    await manager.persist(sessionId);

    const newest = await store.history(DEVICE, THREAD, 2);
    const older = await store.history(DEVICE, THREAD, 2, newest.nextBefore);
    const text = (page: Awaited<ReturnType<typeof store.history>>) =>
      page.entries.map((e) => (e.role === "tool" ? "tool" : e.text));
    assert.deepEqual(text(newest), ["trois", "quatre", "/compact", "Compacted."]);
    assert.deepEqual(text(older), ["un", "deux", "/stop", "Stopped."]);
  });

  test("a command older than every surviving message is still replayed", async () => {
    await saveSession(sessionId, session(sessionId, [
      { role: "user", content: "apres", timestamp: "2026-01-01T00:10:00.000Z" },
      { role: "assistant", content: "ok", timestamp: "2026-01-01T00:10:01.000Z" },
    ]));
    const loaded = (await manager.peek(sessionId))!;
    loaded.commands = [{ input: "/compact", output: "Compacted.", timestamp: "2026-01-01T00:00:05.000Z" }];
    await manager.persist(sessionId);

    const page = await store.history(DEVICE, THREAD);
    assert.equal(page.hasMore, false);
    assert.deepEqual(
      page.entries.map((e) => (e.role === "tool" ? "tool" : e.text)),
      ["/compact", "Compacted.", "apres", "ok"],
    );
  });

  test("a long journal is replayed whole, alongside the messages of its window", async () => {
    await saveSession(sessionId, session(sessionId, [
      { role: "user", content: "salut", timestamp: "2026-01-01T00:00:01.000Z" },
    ]));
    const loaded = (await manager.peek(sessionId))!;
    loaded.commands = Array.from({ length: 30 }, (_, i) => ({
      input: `/status ${i}`,
      output: "ok",
      timestamp: `2026-01-01T01:00:${String(i).padStart(2, "0")}.000Z`,
    }));
    await manager.persist(sessionId);

    const { entries } = await store.history(DEVICE, THREAD);
    const inputs = entries.filter((e) => e.role === "user").map((e) => (e.role === "tool" ? "" : e.text));
    // Nothing is hidden: a journal entry belongs to exactly one page, so a page that showed only
    // the last twenty put the rest out of reach for good.
    assert.equal(inputs.length, 31, "one real message plus the whole journal");
    assert.equal(inputs.includes("/status 0"), true);
    assert.equal(inputs.at(-1), "/status 29");
  });

  test("a command on a thread with no session yet is dropped rather than creating one", async () => {
    await store.recordCommand(DEVICE, THREAD, "/status", "context 0%");
    assert.equal(await loadSession(sessionId), null);
  });

  test("the journal keeps everything, however long the conversation runs", async () => {
    await saveSession(sessionId, session(sessionId, [{ role: "user", content: "salut", timestamp: "2026-01-01T00:00:01.000Z" }]));
    for (let i = 0; i < 205; i++) {
      await store.recordCommand(DEVICE, THREAD, `/status ${i}`, "ok");
    }
    const stored = await loadSession(sessionId);
    assert.equal(stored?.commands?.length, 205);
    assert.equal(stored?.commands?.[0]!.input, "/status 0");
  });

  test("the journal dies with the conversation", async () => {
    await saveSession(sessionId, session(sessionId, [{ role: "user", content: "salut", timestamp: "2026-01-01T00:00:01.000Z" }]));
    await store.recordCommand(DEVICE, THREAD, "/compact", "Compacted.");
    await store.remove(DEVICE, THREAD);
    assert.equal(await loadSession(sessionId), null);
  });
});

describe("MyClawAppSessionStoreImpl replay ids", () => {
  let store: MyClawAppSessionStoreImpl;
  let sessionId: string;

  beforeEach(async () => {
    store = new MyClawAppSessionStoreImpl(new SessionManager(), new SessionFileStore());
    sessionId = store.resolveSessionId(DEVICE, THREAD);
    await deleteSession(sessionId);
  });

  // The app merges a page into the thread it already shows, so a replayed bubble has to carry the
  // id the live one had or the question of a run in flight is either doubled or dropped.
  test("a user turn replays under the device's own send id", async () => {
    await saveSession(sessionId, session(sessionId, [
      { role: "user", content: "la question", timestamp: "2026-01-01T00:00:01.000Z", sourceId: "send-7" },
      { role: "user", content: "venue d'ailleurs", timestamp: "2026-01-01T00:00:02.000Z" },
    ]));

    const { entries } = await store.history(DEVICE, THREAD);
    assert.equal(entries[0]!.id, "send-7");
    // A turn from another channel has no device bubble to match: the positional id stands.
    assert.match(entries[1]!.id, /^h-/);
  });

  test("a journalled command replays under the ids its live bubbles had", async () => {
    await saveSession(sessionId, session(sessionId, [
      { role: "user", content: "salut", timestamp: "2026-01-01T00:00:01.000Z" },
    ]));
    await store.recordCommand(DEVICE, THREAD, "/compact", "Compacted.", undefined, "send-9");

    const { entries } = await store.history(DEVICE, THREAD);
    const ids = entries.map((e) => e.id);
    assert.equal(ids.includes("send-9"), true, "the command bubble is the send itself");
    assert.equal(ids.includes("cmd-send-9"), true, "the answer keeps the id the app gave it");
  });
});

describe("MyClawAppSessionStoreImpl failure journal", () => {
  let manager: SessionManager;
  let store: MyClawAppSessionStoreImpl;
  let sessionId: string;

  beforeEach(async () => {
    manager = new SessionManager();
    store = new MyClawAppSessionStoreImpl(manager, new SessionFileStore());
    sessionId = store.resolveSessionId(DEVICE, THREAD);
    await deleteSession(sessionId);
  });

  test("a failed run replays under the question it never answered", async () => {
    await saveSession(sessionId, session(sessionId, [
      { role: "user", content: "continue", timestamp: "2026-01-01T00:00:01.000Z" },
    ]));
    await store.recordFailure(DEVICE, THREAD, "API Error: 529 Overloaded");

    const stored = await loadSession(sessionId);
    assert.equal(stored?.messages.length, 1, "the journal must never reach the prompt");
    assert.equal(stored?.failures?.length, 1);

    const { entries } = await store.history(DEVICE, THREAD);
    assert.deepEqual(entries.map((e) => e.role), ["user", "assistant"]);
    const failed = entries[1]!;
    if (failed.role === "tool") throw new Error("expected a text entry");
    assert.equal(failed.error, "API Error: 529 Overloaded");
    assert.equal(failed.text, "");
  });

  test("failures and commands replay in the order they happened", async () => {
    await saveSession(sessionId, session(sessionId, [
      { role: "user", content: "salut", timestamp: "2026-01-01T00:00:01.000Z" },
      { role: "assistant", content: "salut", timestamp: "2026-01-01T00:00:09.000Z" },
    ]));
    const loaded = (await manager.peek(sessionId))!;
    loaded.commands = [{ input: "/status", output: "context 12%", timestamp: "2026-01-01T00:00:05.000Z" }];
    loaded.failures = [
      { error: "first died", timestamp: "2026-01-01T00:00:03.000Z" },
      { error: "second died", timestamp: "2026-01-01T00:00:07.000Z" },
    ];
    await manager.persist(sessionId);

    const { entries } = await store.history(DEVICE, THREAD);
    const texts = entries.map((e) => (e.role === "tool" ? "tool" : e.error ?? e.text));
    assert.deepEqual(texts, ["salut", "first died", "/status", "context 12%", "second died", "salut"]);
  });

  test("an empty error is not journalled, and a long one is capped", async () => {
    await saveSession(sessionId, session(sessionId, [
      { role: "user", content: "salut", timestamp: "2026-01-01T00:00:01.000Z" },
    ]));
    await store.recordFailure(DEVICE, THREAD, "   ");
    await store.recordFailure(DEVICE, THREAD, "x".repeat(FAILURE_TEXT_LIMIT + 50));

    const stored = await loadSession(sessionId);
    assert.equal(stored?.failures?.length, 1);
    assert.equal(stored?.failures?.[0]!.error.length, FAILURE_TEXT_LIMIT);
  });

  test("a failure on a thread with no session yet is dropped rather than creating one", async () => {
    await store.recordFailure(DEVICE, THREAD, "boom");
    assert.equal(await loadSession(sessionId), null);
  });
});

describe("MyClawAppSessionStoreImpl thinking counts", () => {
  let store: MyClawAppSessionStoreImpl;
  let sessionId: string;

  beforeEach(async () => {
    store = new MyClawAppSessionStoreImpl(new SessionManager(), new SessionFileStore());
    sessionId = store.resolveSessionId(DEVICE, THREAD);
    await deleteSession(sessionId);
  });

  test("a replayed turn says how much it thought, even with no text to show", async () => {
    await saveSession(sessionId, session(sessionId, [
      { role: "user", content: "9.11 ou 9.8 ?", timestamp: "2026-01-01T00:00:01.000Z" },
      { role: "assistant", content: "9.11", timestamp: "2026-01-01T00:00:02.000Z", reasoningTokens: 12_300 },
    ]));

    const { entries } = await store.history(DEVICE, THREAD);
    const reply = entries[1]!;
    if (reply.role === "tool") throw new Error("expected a text entry");
    assert.equal(reply.reasoningTokens, 12_300);
    assert.equal(reply.reasoning, undefined);
  });

  test("a turn that thought nothing replays without the field", async () => {
    await saveSession(sessionId, session(sessionId, [
      { role: "assistant", content: "hop", timestamp: "2026-01-01T00:00:02.000Z" },
    ]));
    const { entries } = await store.history(DEVICE, THREAD);
    const reply = entries[0]!;
    if (reply.role === "tool") throw new Error("expected a text entry");
    assert.equal(reply.reasoningTokens, undefined);
  });
});

describe("MyClawAppSessionStoreImpl drafts", () => {
  let store: MyClawAppSessionStoreImpl;
  let drafts: DraftStore;
  let sessionId: string;

  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), "session-drafts-"));
    drafts = new DraftStore(join(dir, "drafts.json"));
    store = new MyClawAppSessionStoreImpl(new SessionManager(), new SessionFileStore(), undefined, undefined, drafts);
    sessionId = store.resolveSessionId(DEVICE, THREAD);
    await deleteSession(sessionId);
  });

  afterEach(() => {
    drafts.close();
  });

  test("the listing marks a conversation holding unsent text, and only that one", async () => {
    const other = store.resolveSessionId(DEVICE, "thread-2");
    await saveSession(sessionId, session(sessionId, []));
    await saveSession(other, session(other, []));
    try {
      await store.setDraft(DEVICE, THREAD, "pas encore envoye");

      const listed = await store.list(DEVICE);
      const marked = listed.find((entry) => entry.threadId === THREAD);
      const plain = listed.find((entry) => entry.threadId === "thread-2");
      assert.equal(marked?.hasDraft, true);
      assert.equal(plain?.hasDraft, undefined, "one bit, and absent rather than false");
    } finally {
      await deleteSession(other);
    }
  });

  test("the newest page carries the draft, a page reaching backwards does not", async () => {
    await saveSession(sessionId, session(sessionId, [
      { role: "user", content: "premiere", timestamp: "2026-01-01T00:00:01.000Z" },
      { role: "assistant", content: "reponse", timestamp: "2026-01-01T00:00:02.000Z" },
      { role: "user", content: "seconde", timestamp: "2026-01-01T00:00:03.000Z" },
    ]));
    await store.setDraft(DEVICE, THREAD, "en cours d'ecriture");

    const newest = await store.history(DEVICE, THREAD, 1);
    assert.equal(newest.draft, "en cours d'ecriture");

    const older = await store.history(DEVICE, THREAD, 1, 1);
    assert.equal(older.draft, undefined);
  });

  test("a thread with no session yet still replays its draft", async () => {
    // Where it matters most: the first message of a new conversation, written before anything
    // exists on disk to attach it to.
    await store.setDraft(DEVICE, "brand-new", "premier message, long");
    const page = await store.history(DEVICE, "brand-new");
    assert.deepEqual(page.entries, []);
    assert.equal(page.draft, "premier message, long");
  });

  test("a draft never enters the session file, so no prompt can ever read it", async () => {
    await saveSession(sessionId, session(sessionId, [{ role: "user", content: "envoye", timestamp: "2026-01-01T00:00:01.000Z" }]));
    await store.setDraft(DEVICE, THREAD, "SECRET-DRAFT-SENTINEL");
    await drafts.flush();

    const reloaded = await loadSession(sessionId);
    assert.ok(reloaded);
    assert.equal(JSON.stringify(reloaded).includes("SECRET-DRAFT-SENTINEL"), false);
  });

  test("clearing a draft reports whether there was one", async () => {
    await store.setDraft(DEVICE, THREAD, "quelque chose");
    assert.equal(await store.clearDraft(DEVICE, THREAD), true);
    assert.equal(await store.clearDraft(DEVICE, THREAD), false);
  });
});
