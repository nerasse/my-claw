import { test, afterEach, beforeEach, describe } from "bun:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { MobileAdapter } from "../src/channels/mobile/adapter.ts";
import type { MobileChannelConfig } from "../src/core/config.ts";
import { MY_CLAW_DIR } from "../src/core/config.ts";
import type { ToolApprovalRequest, UnifiedMessage } from "../src/channels/types.ts";

const DEVICE_ID = "test-device";
const TOKEN = "secret-token";

function createConfig(overrides: Partial<MobileChannelConfig> = {}): MobileChannelConfig {
  return {
    port: 0,
    devices: { [DEVICE_ID]: { token: TOKEN, name: "test phone" } },
    streaming: { enabled: true, minChars: 1 },
    ...overrides,
  };
}

interface WsClient {
  ws: WebSocket;
  frames: unknown[];
  closed: { code: number; reason: string } | null;
}

function connectClient(port: number, device = DEVICE_ID, token = TOKEN): Promise<WsClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/mobile?device=${device}&token=${token}`);
    const client: WsClient = { ws, frames: [], closed: null };
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      reject(new Error("ws open timeout"));
    }, 5000);
    ws.onopen = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(client);
    };
    ws.onerror = () => {
      if (settled) return;
      // Keep waiting for close: a rejected upgrade surfaces as close, not error.
    };
    ws.onmessage = (event) => {
      const raw = event.data as string;
      try {
        client.frames.push(JSON.parse(raw));
      } catch {
        client.frames.push(raw);
      }
    };
    ws.onclose = (event) => {
      client.closed = { code: event.code, reason: event.reason };
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(client);
      }
    };
  });
}

function nextFrame(client: WsClient, timeoutMs = 3000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no frame within timeout")), timeoutMs);
    const check = () => {
      if (client.frames.length > 0) {
        clearTimeout(timer);
        resolve(client.frames.shift() as Record<string, unknown>);
        return;
      }
      setTimeout(check, 10);
    };
    check();
  });
}

function waitClosed(client: WsClient, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("ws close timeout")), timeoutMs);
    const check = () => {
      if (client.closed) {
        clearTimeout(timer);
        resolve();
        return;
      }
      setTimeout(check, 10);
    };
    check();
  });
}

async function waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("condition not met within timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}

function streamerMessage(adapter: MobileAdapter, id: string, chatId: string): UnifiedMessage {
  return {
    id,
    platform: "mobile",
    userId: chatId,
    chatId,
    chatType: "dm",
    text: "",
    attachments: [],
    isForwarded: false,
    raw: { type: "chat.send", id, text: "" },
  };
}

function approvalRequest(): ToolApprovalRequest {
  return {
    id: "a1",
    platform: "mobile",
    chatId: DEVICE_ID,
    userId: DEVICE_ID,
    chatType: "dm",
    messageId: "m1",
    sessionId: "s1",
    toolName: "bash",
    args: { command: "ls" },
  };
}

class FakeSessionStore {
  summaries: Array<{ threadId: string; title: string; messageCount: number; createdAt: string; lastActiveAt: string }> = [];
  historyMap = new Map<string, Array<{ id: string; role: "user" | "assistant"; text: string; ts: string }>>();
  archived: string[] = [];
  removed: string[] = [];

  resolveSessionId(deviceId: string, threadId: string): string {
    return `mobile/thread/${deviceId}/${threadId}`;
  }

  async list(deviceId: string): Promise<typeof this.summaries> {
    return this.summaries;
  }

  async history(deviceId: string, threadId: string): Promise<Array<{ id: string; role: "user" | "assistant"; text: string; ts: string }>> {
    return this.historyMap.get(threadId) ?? [];
  }

  async archive(deviceId: string, threadId: string): Promise<void> {
    this.archived.push(threadId);
    this.historyMap.set(threadId, []);
  }

  async remove(deviceId: string, threadId: string): Promise<void> {
    this.removed.push(threadId);
    this.historyMap.delete(threadId);
  }
}

describe("MobileAdapter", () => {
  let adapter: MobileAdapter;
  let client: WsClient;
  let received: UnifiedMessage[];
  let store: FakeSessionStore;

  beforeEach(async () => {
    store = new FakeSessionStore();
    adapter = new MobileAdapter(createConfig(), store as never);
    received = [];
    adapter.onMessage(async (msg) => {
      received.push(msg);
    });
    await adapter.start();
    client = await connectClient(adapter.port);
    received = [];
  });

  afterEach(async () => {
    client?.ws.close();
    await adapter.stop();
  });

  test("rejects unpaired devices and wrong tokens", async () => {
    const unknown = await connectClient(adapter.port, "unknown-device", TOKEN);
    assert.notEqual(unknown.closed?.code, 1000, "unknown device must not connect cleanly");
    unknown.ws.close();

    const wrongToken = await connectClient(adapter.port, DEVICE_ID, "wrong");
    assert.notEqual(wrongToken.closed?.code, 1000, "wrong token must not connect cleanly");
    wrongToken.ws.close();
  });

  test("routes a chat.send frame as a UnifiedMessage", async () => {
    client.ws.send(JSON.stringify({ type: "chat.send", id: "m1", text: "hello agent" }));
    await waitUntil(() => received.length === 1);

    const msg = received[0]!;
    assert.equal(msg.id, "m1");
    assert.equal(msg.platform, "mobile");
    assert.equal(msg.userId, DEVICE_ID);
    assert.equal(msg.chatId, DEVICE_ID);
    assert.equal(msg.chatType, "dm");
    assert.equal(msg.text, "hello agent");
    assert.equal(msg.sessionScope, "per-user");
  });

  test("treats a plain-text frame as chat.send (console mode)", async () => {
    client.ws.send("plain text from the console");
    await waitUntil(() => received.length === 1);
    assert.equal(received[0]!.text, "plain text from the console");
    assert.equal(received[0]!.chatId, DEVICE_ID);
  });

  test("ignores empty, whitespace-only and unknown frames", async () => {
    client.ws.send("");
    client.ws.send("   ");
    client.ws.send(JSON.stringify({ type: "device.capabilities", accessibility: true }));
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(received.length, 0);
  });

  test("send delivers a chat.message frame to the connected device", async () => {
    await adapter.send(DEVICE_ID, { text: "answer from agent", replyToId: "m1" });
    const frame = await nextFrame(client);
    assert.equal(frame.type, "chat.message");
    assert.equal(frame.text, "answer from agent");
    assert.equal(frame.replyToId, "m1");
    assert.deepEqual(frame.attachments, []);
  });

  test("send with a local attachment registers a servable media id", async () => {
    const tmpDir = join(MY_CLAW_DIR, "tmp");
    await mkdir(tmpDir, { recursive: true });
    const file = join(tmpDir, `mobile-test-${Date.now()}.png`);
    await writeFile(file, "png-bytes");

    await adapter.send(DEVICE_ID, {
      text: "with media",
      attachments: [{ type: "image", path: file, mimeType: "image/png" }],
    });
    const frame = (await nextFrame(client)) as { attachments: Array<{ id: string }> };
    assert.equal(frame.attachments.length, 1);
    const mediaId = frame.attachments[0]!.id;

    const authorized = await fetch(`http://127.0.0.1:${adapter.port}/media/${mediaId}?device=${DEVICE_ID}&token=${TOKEN}`);
    assert.equal(authorized.status, 200);
    assert.equal(await authorized.text(), "png-bytes");
    assert.equal(authorized.headers.get("content-type"), "image/png");

    const unauthorized = await fetch(`http://127.0.0.1:${adapter.port}/media/${mediaId}`);
    assert.equal(unauthorized.status, 401);

    const missing = await fetch(`http://127.0.0.1:${adapter.port}/media/nope?device=${DEVICE_ID}&token=${TOKEN}`);
    assert.equal(missing.status, 404);

    await unlink(file).catch(() => {});
  });

  test("streaming emits start/delta/done frames and abort annotates the error", async () => {
    const streamer = adapter.createStreamer(streamerMessage(adapter, "m1", DEVICE_ID));

    await streamer.push("hello ");
    const start = await nextFrame(client);
    assert.equal(start.type, "chat.stream.start");
    assert.equal(start.replyToId, "m1");

    const delta = await nextFrame(client);
    assert.equal(delta.type, "chat.stream.delta");
    assert.equal(delta.text, "hello ");

    await streamer.push("world");
    const delta2 = await nextFrame(client);
    assert.equal(delta2.type, "chat.stream.delta");
    assert.equal(delta2.text, "world");

    await streamer.finish();
    const done = await nextFrame(client);
    assert.equal(done.type, "chat.stream.done");

    const streamer2 = adapter.createStreamer(streamerMessage(adapter, "m2", DEVICE_ID));
    await streamer2.push("partial");
    await nextFrame(client);
    await nextFrame(client);
    await streamer2.abort("boom");
    const abort = await nextFrame(client);
    assert.equal(abort.type, "chat.stream.abort");
    assert.equal(abort.error, "boom");
  });

  test("a tool call seals the text bubble, emits a card, and later text opens a new bubble", async () => {
    const streamer = adapter.createStreamer(streamerMessage(adapter, "m3", DEVICE_ID));

    await streamer.push("je regarde");
    const start = await nextFrame(client);
    assert.equal(start.type, "chat.stream.start");
    await nextFrame(client);

    await streamer.appendToolUse([{ name: "bash", arguments: { command: "echo hi" }, durationMs: 4, output: "hi\n", ok: true }], true);
    const sealed = await nextFrame(client);
    assert.equal(sealed.type, "chat.stream.done");
    assert.equal(sealed.id, start.id);

    const card = await nextFrame(client);
    assert.equal(card.type, "chat.tool");
    assert.equal(card.name, "bash");
    assert.deepEqual(card.args, { command: "echo hi" });
    assert.equal(card.durationMs, 4);
    assert.equal(card.output, "hi\n");
    assert.equal(card.ok, true);
    assert.equal(card.truncated, false);
    assert.equal(card.turnId, start.id);

    await streamer.push("voila");
    const start2 = await nextFrame(client);
    assert.equal(start2.type, "chat.stream.start");
    assert.notEqual(start2.id, start.id);
    assert.equal(start2.replyToId, undefined);
    const delta2 = await nextFrame(client);
    assert.equal(delta2.text, "voila");

    await streamer.finish();
    const done = await nextFrame(client);
    assert.equal(done.type, "chat.stream.done");
    assert.equal(done.id, start2.id);
  });

  test("tool cards are suppressed when verbose is off and long output is truncated", async () => {
    const quiet = adapter.createStreamer(streamerMessage(adapter, "m4", DEVICE_ID));
    await quiet.appendToolUse([{ name: "bash", arguments: {}, durationMs: 1, output: "x", ok: true }], false);
    await quiet.finish("fini");
    const start = await nextFrame(client);
    assert.equal(start.type, "chat.stream.start");
    const delta = await nextFrame(client);
    assert.equal(delta.text, "fini");
    await nextFrame(client);

    const loud = adapter.createStreamer(streamerMessage(adapter, "m5", DEVICE_ID));
    await loud.appendToolUse([{ name: "read", arguments: {}, durationMs: 2, output: "y".repeat(5000), ok: false }], true);
    const card = await nextFrame(client);
    assert.equal(card.type, "chat.tool");
    assert.equal(card.ok, false);
    assert.equal(card.truncated, true);
    assert.equal(String(card.output).length, 4000);
  });

  test("confirmTool returns deny when approvals are disabled", async () => {
    const decision = await adapter.confirmTool(approvalRequest());
    assert.equal(decision, "deny");
  });

  test("chat.send with threadId routes into that thread", async () => {
    client.ws.send(JSON.stringify({ type: "chat.send", id: "m9", text: "bonjour", threadId: "projet" }));
    await waitUntil(() => received.length === 1);
    assert.equal(received[0]!.threadId, "projet");
    assert.equal(received[0]!.sessionScope, "per-user");
  });

  test("chat.send with an unsafe threadId falls back to default", async () => {
    client.ws.send(JSON.stringify({ type: "chat.send", id: "m10", text: "x", threadId: "../evil" }));
    await waitUntil(() => received.length === 1);
    assert.equal(received[0]!.threadId, "default");
  });

  test("send and stream frames carry the threadId back", async () => {
    await adapter.send(DEVICE_ID, { text: "rep", threadId: "projet" });
    const message = (await nextFrame(client)) as { threadId?: string };
    assert.equal(message.threadId, "projet");

    const streamer = adapter.createStreamer({
      ...streamerMessage(adapter, "m1", DEVICE_ID),
      threadId: "projet",
    });
    await streamer.push("hello");
    const start = (await nextFrame(client)) as { type: string; threadId?: string };
    assert.equal(start.type, "chat.stream.start");
    assert.equal(start.threadId, "projet");
    const delta = (await nextFrame(client)) as { type: string; threadId?: string };
    assert.equal(delta.type, "chat.stream.delta");
    assert.equal(delta.threadId, "projet");
    await streamer.finish();
  });

  test("session.list returns the store summaries", async () => {
    store.summaries = [
      { threadId: "a", title: "salut l'agent", messageCount: 4, createdAt: "t1", lastActiveAt: "t2" },
    ];
    client.ws.send(JSON.stringify({ type: "session.list" }));
    const frame = (await nextFrame(client)) as { type: string; sessions: Array<{ threadId: string }> };
    assert.equal(frame.type, "session.list.result");
    assert.equal(frame.sessions.length, 1);
    assert.equal(frame.sessions[0]!.threadId, "a");
  });

  test("commands.list returns the shared catalog", async () => {
    client.ws.send(JSON.stringify({ type: "commands.list" }));
    const frame = (await nextFrame(client)) as { type: string; commands: Array<{ name: string; description: string }> };
    assert.equal(frame.type, "commands.list.result");
    assert.ok(frame.commands.length >= 15);
    assert.ok(frame.commands.some((c) => c.name === "status" && c.description.length > 0));
    assert.ok(frame.commands.some((c) => c.name === "help"));
  });

  test("uploads a file, routes it as an attachment, and lists it back", async () => {
    const port = adapter.port;
    const upload = await fetch(`http://127.0.0.1:${port}/media?device=${DEVICE_ID}&token=${TOKEN}`, {
      method: "POST",
      headers: { "x-filename": "note.pdf", "x-type": "file", "x-thread-id": "projet" },
      body: new Uint8Array([1, 2, 3, 4, 5]),
    });
    assert.equal(upload.status, 200);
    const meta = (await upload.json()) as { id: string; type: string };
    assert.ok(meta.id.length > 0);

    // A message carrying the attachment reaches the agent with a resolvable path.
    client.ws.send(JSON.stringify({ type: "chat.send", id: "m1", text: "lis ce pdf", threadId: "projet", attachments: [{ id: meta.id, type: "file" }] }));
    await waitUntil(() => received.length === 1);
    const msg = received[0]!;
    assert.equal(msg.attachments.length, 1);
    assert.equal(msg.attachments[0]!.type, "file");
    assert.ok(msg.attachments[0]!.path!.includes("files/mobile/test-device/projet"));

    // The session explorer lists it with its size, and delete empties the list.
    client.ws.send(JSON.stringify({ type: "files.list", threadId: "projet" }));
    const list = (await nextFrame(client)) as { type: string; files: Array<{ id: string; sizeBytes: number }>; totalBytes: number };
    assert.equal(list.type, "files.list.result");
    assert.equal(list.files.length, 1);
    assert.equal(list.files[0]!.id, meta.id);
    assert.equal(list.totalBytes, 5);

    client.ws.send(JSON.stringify({ type: "files.delete", threadId: "projet", id: meta.id }));
    const after = (await nextFrame(client)) as { type: string; files: unknown[] };
    assert.equal(after.type, "files.list.result");
    assert.equal(after.files.length, 0);
  });

  test("the attachment type comes from the stored file, not from what the client claims", async () => {
    const port = adapter.port;
    const upload = await fetch(`http://127.0.0.1:${port}/media?device=${DEVICE_ID}&token=${TOKEN}`, {
      method: "POST",
      headers: { "x-filename": "photo.jpg", "x-type": "file", "x-thread-id": "projet" },
      body: new Uint8Array([1, 2, 3]),
    });
    const meta = (await upload.json()) as { id: string };

    // A jpeg announced as "file" would otherwise skip vision routing entirely.
    client.ws.send(JSON.stringify({ type: "chat.send", id: "m2", text: "regarde", threadId: "projet", attachments: [{ id: meta.id, type: "file" }] }));
    await waitUntil(() => received.length === 1);
    assert.equal(received[0]!.attachments[0]!.type, "image");
  });

  test("archiving a session removes its uploaded files", async () => {
    const upload = await fetch(`http://127.0.0.1:${adapter.port}/media?device=${DEVICE_ID}&token=${TOKEN}`, {
      method: "POST",
      headers: { "x-filename": "pic.png", "x-type": "image", "x-thread-id": "projet" },
      body: new Uint8Array([9, 9, 9]),
    });
    assert.equal(upload.status, 200);

    client.ws.send(JSON.stringify({ type: "session.archive", threadId: "projet" }));
    // The archive ack is sent after the file cleanup completes.
    const ack = (await nextFrame(client)) as { type: string };
    assert.equal(ack.type, "chat.history");
    client.ws.send(JSON.stringify({ type: "files.list", threadId: "projet" }));
    const list = (await nextFrame(client)) as { type: string; files: unknown[] };
    assert.equal(list.type, "files.list.result");
    assert.equal(list.files.length, 0);
  });

  test("uploads are capped by the configured size limit", async () => {
    const small = new MobileAdapter(
      createConfig({ files: { maxSizeBytes: 4 } }),
      store as never,
    );
    small.onMessage(async () => {});
    await small.start();
    const port = small.port;
    try {
      const upload = await fetch(`http://127.0.0.1:${port}/media?device=${DEVICE_ID}&token=${TOKEN}`, {
        method: "POST",
        headers: { "x-filename": "big.bin", "x-type": "file", "x-thread-id": "projet" },
        body: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
      });
      assert.equal(upload.status, 413);
    } finally {
      await small.stop();
    }
  });

  test("session.history returns stored messages for the thread", async () => {
    store.historyMap.set("a", [
      { id: "h1", role: "user", text: "bonjour", ts: "t1" },
      { id: "h2", role: "assistant", text: "bonsoir", ts: "t2" },
    ]);
    client.ws.send(JSON.stringify({ type: "session.history", threadId: "a" }));
    const frame = (await nextFrame(client)) as { type: string; threadId: string; messages: Array<{ text: string }> };
    assert.equal(frame.type, "chat.history");
    assert.equal(frame.threadId, "a");
    assert.equal(frame.messages.length, 2);
    assert.equal(frame.messages[1]!.text, "bonsoir");
  });

  test("session.history with an unsafe threadId returns an error frame", async () => {
    client.ws.send(JSON.stringify({ type: "session.history", threadId: "../x" }));
    const frame = (await nextFrame(client)) as { type: string };
    assert.equal(frame.type, "error");
  });

  test("session.archive archives the thread and replies with empty history", async () => {
    client.ws.send(JSON.stringify({ type: "session.archive", threadId: "a" }));
    const frame = (await nextFrame(client)) as { type: string; messages: unknown[] };
    assert.equal(frame.type, "chat.history");
    assert.deepEqual(frame.messages, []);
    assert.deepEqual(store.archived, ["a"]);
  });

  test("session.delete removes the thread", async () => {
    client.ws.send(JSON.stringify({ type: "session.delete", threadId: "a" }));
    await nextFrame(client);
    assert.deepEqual(store.removed, ["a"]);
  });

  test("confirmTool sends approval.request and accepts a response", async () => {
    const approvalsAdapter = new MobileAdapter(createConfig({ approvals: true }), store as never);
    approvalsAdapter.onMessage(() => Promise.resolve());
    await approvalsAdapter.start();
    const approvalClient = await connectClient(approvalsAdapter.port);

    const decisionPromise = approvalsAdapter.confirmTool(approvalRequest());
    const request = (await nextFrame(approvalClient)) as { type: string; id: string; toolName: string; args: Record<string, unknown> };
    assert.equal(request.type, "approval.request");
    assert.equal(request.toolName, "bash");
    assert.deepEqual(request.args, { command: "ls" });

    approvalClient.ws.send(JSON.stringify({ type: "approval.response", id: request.id, accepted: true }));
    assert.equal(await decisionPromise, "allow-session");

    approvalClient.ws.close();
    await approvalsAdapter.stop();
  });

  test("confirmTool stays pending until timeout (deny)", async () => {
    const approvalsAdapter = new MobileAdapter(createConfig({ approvals: true }), store as never);
    approvalsAdapter.onMessage(() => Promise.resolve());
    await approvalsAdapter.start();
    const approvalClient = await connectClient(approvalsAdapter.port);

    const decisionPromise = approvalsAdapter.confirmTool(approvalRequest());
    await nextFrame(approvalClient);
    const decision = await Promise.race([
      decisionPromise,
      new Promise<string>((r) => setTimeout(() => r("pending"), 800)),
    ]);
    assert.equal(decision, "pending");

    approvalClient.ws.close();
    await approvalsAdapter.stop();
  });

  test("send to an offline device does not throw", async () => {
    client.ws.close();
    await waitClosed(client);
    await adapter.send(DEVICE_ID, { text: "nobody home" });
    await adapter.send("other-device", { text: "never paired" });
  });

  test("stop closes live sockets and releases the port", async () => {
    const port = adapter.port;
    await adapter.stop();
    const probe = await fetch(`http://127.0.0.1:${port}/mobile`).catch(() => null);
    assert.equal(probe, null);
  });
});
