import { test, afterEach, beforeEach, describe } from "bun:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { filesRootForOwner } from "../src/channels/my-claw-app/files.ts";
import { mkdir, writeFile, unlink, readdir, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { MyClawAppAdapter } from "../src/channels/my-claw-app/adapter.ts";
import type { MyClawAppAgentsConfigResult, MyClawAppJobEntry, MyClawAppMcpEntry, MyClawAppToolEntry } from "../src/channels/my-claw-app/types.ts";
import type { MyClawAppChannelConfig } from "../src/core/config.ts";
import { runRegistry } from "../src/core/run-registry.ts";
import { MY_CLAW_DIR } from "../src/core/config.ts";
import type { ToolApprovalRequest, UnifiedMessage } from "../src/channels/types.ts";
import { createJob, loadJobs, removeJob, saveJobs, updateJob } from "../src/cron/store.ts";

const execFileAsync = promisify(execFile);

const DEVICE_ID = "test-device";
const TOKEN = "secret-token";

function createConfig(overrides: Partial<MyClawAppChannelConfig> = {}): MyClawAppChannelConfig {
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

function connectClient(port: number, device = DEVICE_ID, token = TOKEN, receiveLocationCapabilities = false, receiveHello = false): Promise<WsClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/my-claw-app?device=${device}&token=${token}`);
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
        const frame = JSON.parse(raw) as { type?: unknown };
        if (!receiveLocationCapabilities && frame.type === "location.capabilities") return;
        if (!receiveHello && frame.type === "hello") return;
        client.frames.push(frame);
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

function streamerMessage(adapter: MyClawAppAdapter, id: string, chatId: string): UnifiedMessage {
  return {
    id,
    platform: "my-claw-app",
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
    platform: "my-claw-app",
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
  summaries: Array<{ threadId: string; title: string; messageCount: number; createdAt: string; lastActiveAt: string; archived?: boolean; pinRank?: number }> = [];
  historyMap = new Map<string, Array<{ id: string; role: "user" | "assistant"; text: string; ts: string }>>();
  archived: string[] = [];
  unarchived: string[] = [];
  removed: string[] = [];

  resolveSessionId(deviceId: string, threadId: string): string {
    return `my-claw-app/thread/${deviceId}/${threadId}`;
  }

  async list(deviceId: string): Promise<typeof this.summaries> {
    return this.summaries;
  }

  historyCalls: Array<{ limit?: number; before?: number }> = [];

  async history(
    deviceId: string,
    threadId: string,
    limit?: number,
    before?: number,
  ): Promise<{
    entries: Array<{ id: string; role: "user" | "assistant"; text: string; ts: string }>;
    hasMore: boolean;
    nextBefore: number;
  }> {
    this.historyCalls.push({ limit, before });
    const all = this.historyMap.get(threadId) ?? [];
    const end = Math.max(all.length - (before ?? 0), 0);
    const start = Math.max(end - (limit ?? all.length), 0);
    return { entries: all.slice(start, end), hasMore: start > 0, nextBefore: all.length - start };
  }

  journal: Array<{ threadId: string; input: string; output: string; details?: string }> = [];

  async recordCommand(deviceId: string, threadId: string, input: string, output: string, details?: string): Promise<void> {
    this.journal.push({ threadId, input, output, ...(details ? { details } : {}) });
  }

  failures: Array<{ threadId: string; error: string }> = [];

  async recordFailure(deviceId: string, threadId: string, error: string): Promise<void> {
    this.failures.push({ threadId, error });
  }

  async archive(deviceId: string, threadId: string): Promise<void> {
    this.archived.push(threadId);
    const entry = this.summaries.find((summary) => summary.threadId === threadId);
    if (entry) entry.archived = true;
  }

  async unarchive(deviceId: string, threadId: string): Promise<void> {
    this.unarchived.push(threadId);
    const entry = this.summaries.find((summary) => summary.threadId === threadId);
    if (entry) delete entry.archived;
  }

  async remove(deviceId: string, threadId: string): Promise<void> {
    this.removed.push(threadId);
    this.historyMap.delete(threadId);
  }

  pinCalls: Array<{ threadId: string; pinned: boolean }> = [];
  pinOrders: string[][] = [];

  async setPinned(deviceId: string, threadId: string, pinned: boolean): Promise<void> {
    this.pinCalls.push({ threadId, pinned });
    const entry = this.summaries.find((summary) => summary.threadId === threadId);
    if (!entry) throw new Error("conversation not found");
    if (pinned) entry.pinRank = this.summaries.filter((summary) => summary.pinRank !== undefined).length;
    else delete entry.pinRank;
  }

  async setPinOrder(deviceId: string, threadIds: string[]): Promise<void> {
    this.pinOrders.push(threadIds);
    threadIds.forEach((threadId, rank) => {
      const entry = this.summaries.find((summary) => summary.threadId === threadId);
      if (entry) entry.pinRank = rank;
    });
  }

  async rename(deviceId: string, threadId: string, title: string): Promise<void> {
    const entry = this.summaries.find((summary) => summary.threadId === threadId);
    if (!entry) throw new Error("conversation not found");
    entry.title = title.trim() || "(new conversation)";
  }

  workspaceByThread = new Map<string, string>();

  async setWorkspace(deviceId: string, threadId: string, workspace: string): Promise<void> {
    if (workspace !== "default" && workspace !== "sofa") throw new Error(`unknown workspace: ${workspace}`);
    this.workspaceByThread.set(threadId, workspace);
  }

}

describe("MyClawAppAdapter", () => {
  let adapter: MyClawAppAdapter;
  let client: WsClient;
  let received: UnifiedMessage[];
  let store: FakeSessionStore;

  beforeEach(async () => {
    store = new FakeSessionStore();
    adapter = new MyClawAppAdapter(createConfig(), store as never);
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
    // Uploads outlive the adapter that stored them: leaving them behind made the file tests
    // depend on their order (bun test --randomize --seed=2 caught it).
    await rm(filesRootForOwner(DEVICE_ID), { recursive: true, force: true });
    await rm(filesRootForOwner("neras"), { recursive: true, force: true });
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
    assert.equal(msg.platform, "my-claw-app");
    assert.equal(msg.userId, DEVICE_ID);
    assert.equal(msg.chatId, DEVICE_ID);
    assert.equal(msg.chatType, "dm");
    assert.equal(msg.text, "hello agent");
    assert.equal(msg.sessionScope, "per-user");
  });

  test("advertises location capability without leaking provider configuration", async () => {
    adapter.onLocationResolver({
      capabilities: () => ({ enabled: true, address: true, provider: "geoapify" }),
      resolve: async input => input,
    });
    const capable = await connectClient(adapter.port, DEVICE_ID, TOKEN, true);
    const frame = await nextFrame(capable);
    assert.deepEqual(frame, {
      type: "location.capabilities",
      enabled: true,
      address: true,
      provider: "geoapify",
    });
    assert.equal(JSON.stringify(frame).includes(TOKEN), false);
    capable.ws.close();
  });

  test("names the server version on connect so the settings page can label it", async () => {
    const greeted = await connectClient(adapter.port, DEVICE_ID, TOKEN, false, true);
    const frame = await nextFrame(greeted);
    assert.equal(frame.type, "hello");
    assert.match(String(frame.version), /^\d+\.\d+\.\d+$/);
    greeted.ws.close();
  });

  test("routes a location-only message and confirms the enriched user bubble", async () => {
    adapter.onLocationResolver({
      capabilities: () => ({ enabled: true, address: true, provider: "geoapify" }),
      resolve: async input => ({
        ...input,
        address: { formatted: "Rue de Rivoli, Paris", level: "street", provider: "geoapify" },
      }),
    });
    client.ws.send(JSON.stringify({
      type: "chat.send",
      id: "location-1",
      text: "",
      location: {
        latitude: 48.8566,
        longitude: 2.3522,
        accuracyMeters: 42,
        capturedAt: "2026-08-13T12:30:00.000Z",
        address: { formatted: "client lies", level: "building", provider: "geoapify" },
      },
    }));
    await waitUntil(() => received.length === 1);
    assert.equal(received[0]!.location?.address?.formatted, "Rue de Rivoli, Paris");
    assert.notEqual(received[0]!.location?.address?.formatted, "client lies");

    const frame = await nextFrame(client);
    assert.equal(frame.type, "chat.location");
    assert.equal(frame.replyToId, "location-1");
    assert.equal((frame.location as { address?: { level?: string } }).address?.level, "street");
  });

  test("location.preview geocodes without routing a message", async () => {
    adapter.onLocationResolver({
      capabilities: () => ({ enabled: true, address: true, provider: "geoapify" }),
      resolve: async input => ({
        ...input,
        address: { formatted: "Rue de Rivoli, Paris", level: "street", provider: "geoapify" },
      }),
    });
    client.ws.send(JSON.stringify({
      type: "location.preview",
      id: "preview-1",
      location: {
        latitude: 48.8566,
        longitude: 2.3522,
        accuracyMeters: 42,
        capturedAt: "2026-08-13T12:30:00.000Z",
      },
    }));
    const frame = await nextFrame(client);
    assert.equal(frame.type, "location.preview.result");
    assert.equal(frame.id, "preview-1");
    assert.equal((frame.location as { address?: { formatted?: string } }).address?.formatted, "Rue de Rivoli, Paris");
    assert.equal(received.length, 0);
  });

  test("an owner-edited address rides the message and is flagged edited", async () => {
    adapter.onLocationResolver({
      capabilities: () => ({ enabled: true, address: true, provider: "geoapify" }),
      resolve: async input => ({
        ...input,
        address: { formatted: "Rue de Rivoli, Paris", level: "street", provider: "geoapify" },
      }),
    });
    client.ws.send(JSON.stringify({
      type: "chat.send",
      id: "location-2",
      text: "",
      location: {
        latitude: 48.8566,
        longitude: 2.3522,
        accuracyMeters: 42,
        capturedAt: "2026-08-13T12:30:00.000Z",
        addressOverride: { formatted: "Chez moi" },
      },
    }));
    await waitUntil(() => received.length === 1);
    assert.deepEqual(received[0]!.location?.address, {
      formatted: "Chez moi",
      level: "street",
      provider: "geoapify",
      edited: true,
    });

    const frame = await nextFrame(client);
    assert.equal(frame.type, "chat.location");
    assert.equal((frame.location as { address?: { edited?: boolean } }).address?.edited, true);
  });

  test("an empty address override sends coordinates only", async () => {
    adapter.onLocationResolver({
      capabilities: () => ({ enabled: true, address: true, provider: "geoapify" }),
      resolve: async input => ({
        ...input,
        address: { formatted: "Rue de Rivoli, Paris", level: "street", provider: "geoapify" },
      }),
    });
    client.ws.send(JSON.stringify({
      type: "chat.send",
      id: "location-3",
      text: "",
      location: {
        latitude: 48.8566,
        longitude: 2.3522,
        accuracyMeters: 42,
        capturedAt: "2026-08-13T12:30:00.000Z",
        addressOverride: { formatted: "   " },
      },
    }));
    await waitUntil(() => received.length === 1);
    assert.equal(received[0]!.location?.address, undefined);
    assert.equal(received[0]!.location?.latitude, 48.8566);
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

  test("a frame missing its required fields is survived, not fatal", async () => {
    // A frame is typed on the wire and nowhere else. One field short, these used to throw out of
    // the socket callback (or out of the promise a handler returned) and take the whole daemon
    // down, every channel with it, on a device one version off.
    client.ws.send(JSON.stringify({ type: "chat.send", id: "m1" }));
    client.ws.send(JSON.stringify({ type: "chat.send", id: "m2", text: "hi", attachments: 7 }));
    client.ws.send(JSON.stringify({ type: "device.pair.deny" }));
    client.ws.send(JSON.stringify({ type: "device.pair.lookup" }));
    client.ws.send(JSON.stringify({ type: "session.history" }));
    client.ws.send(JSON.stringify({ type: "device.revoke" }));

    // The socket is still up and still serving: send a real frame and expect a real answer.
    client.ws.send(JSON.stringify({ type: "chat.send", id: "m3", text: "still alive" }));
    await waitUntil(() => received.some((msg) => msg.text === "still alive"));
    // The garbage `attachments` is dropped, the text it came with is not.
    assert.deepEqual(received.map((msg) => msg.text), ["hi", "still alive"]);
  });

  test("send delivers a chat.message frame to the connected device", async () => {
    await adapter.send(DEVICE_ID, { text: "answer from agent", replyToId: "m1" });
    const frame = await nextFrame(client);
    assert.equal(frame.type, "chat.message");
    assert.equal(frame.text, "answer from agent");
    assert.equal(frame.replyToId, "m1");
    assert.deepEqual(frame.attachments, []);
  });

  test("send with a local attachment copies it into the session store and serves it", async () => {
    const tmpDir = join(MY_CLAW_DIR, "tmp");
    await mkdir(tmpDir, { recursive: true });
    const name = `app-test-${Date.now()}.png`;
    const file = join(tmpDir, name);
    await writeFile(file, "png-bytes");

    await adapter.send(DEVICE_ID, {
      text: "with media",
      attachments: [{ type: "image", path: file, mimeType: "image/png" }],
    });
    const frame = (await nextFrame(client)) as { attachments: Array<{ id: string; filename: string; sizeBytes: number }> };
    assert.equal(frame.attachments.length, 1);
    assert.equal(frame.attachments[0]!.filename, name);
    assert.equal(frame.attachments[0]!.sizeBytes, 9);
    const mediaId = frame.attachments[0]!.id;

    const authorized = await fetch(`http://127.0.0.1:${adapter.port}/media/${mediaId}?device=${DEVICE_ID}&token=${TOKEN}`);
    assert.equal(authorized.status, 200);
    assert.equal(await authorized.text(), "png-bytes");
    assert.equal(authorized.headers.get("content-type"), "image/png");

    // The copy landed in the conversation's store directory, `<id>__<name>`.
    const threadDir = join(filesRootForOwner(DEVICE_ID), "default");
    const entries = await readdir(threadDir);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!, `${mediaId}__${name}`);
    assert.equal(await readFile(join(threadDir, entries[0]!), "utf-8"), "png-bytes");

    // Served from the copy: removing the source changes nothing.
    await unlink(file).catch(() => {});
    const persisted = await fetch(`http://127.0.0.1:${adapter.port}/media/${mediaId}?device=${DEVICE_ID}&token=${TOKEN}`);
    assert.equal(persisted.status, 200);
    assert.equal(await persisted.text(), "png-bytes");

    const unauthorized = await fetch(`http://127.0.0.1:${adapter.port}/media/${mediaId}`);
    assert.equal(unauthorized.status, 401);

    const missing = await fetch(`http://127.0.0.1:${adapter.port}/media/nope?device=${DEVICE_ID}&token=${TOKEN}`);
    assert.equal(missing.status, 404);
  });

  test("a video serves a generated preview frame under ?thumb=1", async () => {
    const tmpDir = join(MY_CLAW_DIR, "tmp");
    await mkdir(tmpDir, { recursive: true });
    const videoPath = join(tmpDir, `clip-${Date.now()}.mp4`);
    await execFileAsync("ffmpeg", [
      "-f", "lavfi",
      "-i", "testsrc=duration=2:size=320x240:rate=1",
      "-t", "2",
      "-pix_fmt", "yuv420p",
      videoPath,
    ]);

    await adapter.send(DEVICE_ID, { text: `MEDIA:${videoPath} regarde` });
    const frame = (await nextFrame(client)) as { text: string; attachments: Array<{ id: string; type: string }> };
    assert.equal(frame.text, "regarde");
    assert.equal(frame.attachments[0]!.type, "video");
    const mediaId = frame.attachments[0]!.id;

    // The video itself still serves as video.
    const video = await fetch(`http://127.0.0.1:${adapter.port}/media/${mediaId}?device=${DEVICE_ID}&token=${TOKEN}`);
    assert.equal(video.status, 200);
    assert.equal(video.headers.get("content-type"), "video/mp4");

    // The preview frame is a jpeg, generated once and served again from the cache.
    const first = await fetch(`http://127.0.0.1:${adapter.port}/media/${mediaId}?device=${DEVICE_ID}&token=${TOKEN}&thumb=1`);
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("content-type"), "image/jpeg");
    const firstBytes = await first.arrayBuffer();
    assert.ok(firstBytes.byteLength > 0);
    const second = await fetch(`http://127.0.0.1:${adapter.port}/media/${mediaId}?device=${DEVICE_ID}&token=${TOKEN}&thumb=1`);
    assert.deepEqual(new Uint8Array(await second.arrayBuffer()), new Uint8Array(firstBytes));

    // Only videos get previews; a missing media and a non-video media answer 404 too.
    const missingThumb = await fetch(`http://127.0.0.1:${adapter.port}/media/nope?device=${DEVICE_ID}&token=${TOKEN}&thumb=1`);
    assert.equal(missingThumb.status, 404);

    const imagePath = join(tmpDir, `shot-${Date.now()}.png`);
    await writeFile(imagePath, "png-bytes");
    await adapter.send(DEVICE_ID, { text: `MEDIA:${imagePath} vu` });
    const imageFrame = (await nextFrame(client)) as { attachments: Array<{ id: string }> };
    const imageThumb = await fetch(
      `http://127.0.0.1:${adapter.port}/media/${imageFrame.attachments[0]!.id}?device=${DEVICE_ID}&token=${TOKEN}&thumb=1`,
    );
    assert.equal(imageThumb.status, 404);
    await unlink(imagePath).catch(() => {});

    await unlink(videoPath).catch(() => {});
  });

  test("MEDIA refs are copied into the session store and listed as session files", async () => {
    const tmpDir = join(MY_CLAW_DIR, "tmp");
    await mkdir(tmpDir, { recursive: true });
    const name = `agent-voice-${Date.now()}.m4a`;
    const file = join(tmpDir, name);
    await writeFile(file, "voice-bytes");

    await adapter.send(DEVICE_ID, { text: `MEDIA:${file} answering` });
    const frame = (await nextFrame(client)) as { text: string; attachments: Array<{ id: string; type: string; filename: string }> };
    assert.equal(frame.text, "answering");
    assert.equal(frame.attachments.length, 1);
    assert.equal(frame.attachments[0]!.type, "audio");
    assert.equal(frame.attachments[0]!.filename, name);

    const got = await fetch(`http://127.0.0.1:${adapter.port}/media/${frame.attachments[0]!.id}?device=${DEVICE_ID}&token=${TOKEN}`);
    assert.equal(got.status, 200);
    assert.equal(await got.text(), "voice-bytes");

    // The session explorer counts the agent's copy as a conversation file.
    client.ws.send(JSON.stringify({ type: "files.list", threadId: "default" }));
    const list = (await nextFrame(client)) as { type: string; files: Array<{ filename: string }> };
    assert.equal(list.files.length, 1);
    assert.equal(list.files[0]!.filename, frame.attachments[0]!.filename);

    // A regenerated file is a fresh copy, never a deduplicated old one.
    await writeFile(file, "voice-bytes-v2");
    await adapter.send(DEVICE_ID, { text: `MEDIA:${file} again` });
    const again = (await nextFrame(client)) as { attachments: Array<{ id: string }> };
    assert.equal(again.attachments.length, 1);
    assert.notEqual(again.attachments[0]!.id, frame.attachments[0]!.id);
    const fresh = await fetch(`http://127.0.0.1:${adapter.port}/media/${again.attachments[0]!.id}?device=${DEVICE_ID}&token=${TOKEN}`);
    assert.equal(await fresh.text(), "voice-bytes-v2");

    await unlink(file).catch(() => {});
  });

  test("MEDIA refs to any file format keep the file's real type", async () => {
    const tmpDir = join(MY_CLAW_DIR, "tmp");
    await mkdir(tmpDir, { recursive: true });
    const cases: Array<[string, string, string]> = [
      [`shot-${Date.now()}.jpg`, "image", "image/jpeg"],
      [`shot-${Date.now()}.png`, "image", "image/png"],
      [`clip-${Date.now()}.mp4`, "video", "video/mp4"],
      [`notes-${Date.now()}.txt`, "file", "text/plain"],
      [`doc-${Date.now()}.md`, "file", "text/markdown"],
      [`data-${Date.now()}.pdf`, "file", "application/pdf"],
      [`voice-${Date.now()}.m4a`, "audio", "audio/mp4"],
    ];

    for (const [name, expectedType, expectedMime] of cases) {
      const file = join(tmpDir, name);
      await writeFile(file, "bytes");
      await adapter.send(DEVICE_ID, { text: `MEDIA:${file} here` });
      const frame = (await nextFrame(client)) as { text: string; attachments: Array<{ id: string; type: string; filename: string; mimeType: string }> };
      assert.equal(frame.text, "here");
      assert.equal(frame.attachments.length, 1);
      assert.equal(frame.attachments[0]!.type, expectedType, `type for ${name}`);
      assert.equal(frame.attachments[0]!.mimeType, expectedMime, `mime for ${name}`);
      assert.equal(frame.attachments[0]!.filename, name);
      await unlink(file).catch(() => {});
    }
  });

  test("an attachment whose source file vanished is dropped, not fatal", async () => {
    await adapter.send(DEVICE_ID, {
      text: "stale",
      attachments: [{ type: "file", path: join(MY_CLAW_DIR, "missing.bin") }],
    });
    const frame = (await nextFrame(client)) as { text: string; attachments: unknown[] };
    assert.equal(frame.text, "stale");
    assert.equal(frame.attachments.length, 0);
  });

  test("voice attachments keep audioAsVoice through the store copy", async () => {
    const tmpDir = join(MY_CLAW_DIR, "tmp");
    await mkdir(tmpDir, { recursive: true });
    const file = join(tmpDir, `voice-${Date.now()}.m4a`);
    await writeFile(file, "abc");

    await adapter.send(DEVICE_ID, {
      text: "listen",
      attachments: [{ type: "audio", path: file, mimeType: "audio/mp4", audioAsVoice: true }],
    });
    const frame = (await nextFrame(client)) as { attachments: Array<{ audioAsVoice?: boolean }> };
    assert.equal(frame.attachments.length, 1);
    assert.equal(frame.attachments[0]!.audioAsVoice, true);
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

  test("a delayed first delta carries every token buffered before it", async () => {
    // Production waits for 30 characters before opening the bubble; the default test config
    // starts at 1, which is exactly the setting that hides this.
    const held = new MyClawAppAdapter(createConfig({ port: 0, streaming: { enabled: true, minChars: 30 } }), store);
    held.onMessage(async () => {});
    await held.start();
    const listener = await connectClient(held.port);
    try {
      const streamer = held.createStreamer(streamerMessage(held, "m9", DEVICE_ID));
      const tokens = ["Bonjour, ", "je regarde ", "ce que tu ", "m'as demande ", "tout de suite."];
      for (const token of tokens) await streamer.push(token);
      await streamer.finish();

      await waitUntil(() => listener.frames.some((f) => (f as { type: string }).type === "chat.stream.done"));
      const deltas = listener.frames
        .filter((f) => (f as { type: string }).type === "chat.stream.delta")
        .map((f) => (f as { text: string }).text);

      // The reader must end up with the whole reply, opening words included.
      assert.equal(deltas.join(""), tokens.join(""));
      assert.ok(deltas[0]!.startsWith("Bonjour, "));
    } finally {
      listener.ws.close();
      await held.stop();
    }
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
    assert.ok(msg.attachments[0]!.path!.includes("files/my-claw-app/test-device/projet"));
    // The uploader's name reaches the agent and the explorer, not the generated id.
    assert.equal(msg.attachments[0]!.filename, "note.pdf");
    assert.ok(msg.attachments[0]!.path!.endsWith(`${meta.id}__note.pdf`));

    // The session explorer lists it with its size, and delete empties the list.
    client.ws.send(JSON.stringify({ type: "files.list", threadId: "projet" }));
    const list = (await nextFrame(client)) as { type: string; files: Array<{ id: string; filename: string; sizeBytes: number }>; totalBytes: number };
    assert.equal(list.type, "files.list.result");
    assert.equal(list.files.length, 1);
    assert.equal(list.files[0]!.id, meta.id);
    assert.equal(list.files[0]!.filename, "note.pdf");
    assert.equal(list.totalBytes, 5);

    client.ws.send(JSON.stringify({ type: "files.delete", threadId: "projet", id: meta.id }));
    const after = (await nextFrame(client)) as { type: string; files: unknown[] };
    assert.equal(after.type, "files.list.result");
    assert.equal(after.files.length, 0);
  });

  test("renaming a conversation answers with the list it produced", async () => {
    store.summaries = [
      { threadId: "projet", title: "salut ca va", messageCount: 2, createdAt: "c", lastActiveAt: "l" },
    ];

    client.ws.send(JSON.stringify({ type: "session.rename", threadId: "projet", title: "Infra maison" }));
    const frame = (await nextFrame(client)) as { type: string; sessions: Array<{ title: string }> };

    // The device renders what was stored, never the name it hoped for.
    assert.equal(frame.type, "session.list.result");
    assert.equal(frame.sessions[0]!.title, "Infra maison");
  });

  test("renaming an unknown conversation is refused on the session scope", async () => {
    store.summaries = [];
    client.ws.send(JSON.stringify({ type: "session.rename", threadId: "fantome", title: "X" }));
    const frame = (await nextFrame(client)) as { type: string; scope: string; message: string };
    assert.equal(frame.type, "error");
    assert.equal(frame.scope, "session");
    assert.equal(frame.message, "rename failed");
  });

  test("setting a conversation workspace answers with the stored key", async () => {
    client.ws.send(JSON.stringify({ type: "session.workspace.set", threadId: "projet", workspace: "sofa" }));
    const frame = (await nextFrame(client)) as { type: string; threadId: string; workspace: string };
    assert.equal(frame.type, "session.workspace.set.result");
    assert.equal(frame.threadId, "projet");
    assert.equal(frame.workspace, "sofa");
    assert.equal(store.workspaceByThread.get("projet"), "sofa");
  });

  test("setting the workspace of a fresh conversation is allowed (eager creation)", async () => {
    client.ws.send(JSON.stringify({ type: "session.workspace.set", threadId: "neuf", workspace: "default" }));
    const frame = (await nextFrame(client)) as { type: string; threadId: string; workspace: string };
    assert.equal(frame.type, "session.workspace.set.result");
    assert.equal(frame.workspace, "default");
    assert.equal(store.workspaceByThread.get("neuf"), "default");
  });

  test("setting an unknown workspace key is refused on the session scope", async () => {
    client.ws.send(JSON.stringify({ type: "session.workspace.set", threadId: "projet", workspace: "mars" }));
    const frame = (await nextFrame(client)) as { type: string; scope: string; message: string };
    assert.equal(frame.type, "error");
    assert.equal(frame.scope, "session");
    assert.equal(frame.message, "workspace.set failed");
  });

  test("setting a workspace without a key is refused", async () => {
    client.ws.send(JSON.stringify({ type: "session.workspace.set", threadId: "projet" }));
    const frame = (await nextFrame(client)) as { type: string; scope: string; message: string };
    assert.equal(frame.type, "error");
    assert.equal(frame.scope, "session");
    assert.equal(frame.message, "workspace is required");
  });

  test("the speech-to-text engine can be read and switched from the device", async () => {
    let stored: "cloud" | "local" | "auto" = "auto";
    adapter.onVoiceController({
      status: () => ({ mode: stored, resolved: stored === "local" ? "local" : "cloud", cloudAvailable: true }),
      setMode: async (mode) => { stored = mode; },
    });

    client.ws.send(JSON.stringify({ type: "voice.mode.get" }));
    const initial = (await nextFrame(client)) as { type: string; mode: string; resolved: string; cloudAvailable: boolean };
    assert.equal(initial.type, "voice.mode.result");
    assert.equal(initial.mode, "auto");
    assert.equal(initial.cloudAvailable, true);

    // A set answers with the resulting state, so the app never renders a stale switch.
    client.ws.send(JSON.stringify({ type: "voice.mode.set", mode: "local" }));
    const after = (await nextFrame(client)) as { type: string; mode: string; resolved: string };
    assert.equal(after.type, "voice.mode.result");
    assert.equal(after.mode, "local");
    assert.equal(after.resolved, "local");
    assert.equal(stored, "local");
  });

  test("an unusable voice mode is refused on the voice scope, not silently ignored", async () => {
    adapter.onVoiceController({
      status: () => ({ mode: "auto", resolved: "cloud", cloudAvailable: true }),
      setMode: async () => { throw new Error("config.json unreadable"); },
    });

    client.ws.send(JSON.stringify({ type: "voice.mode.set", mode: "cloud" }));
    const frame = (await nextFrame(client)) as { type: string; message: string; scope: string };
    assert.equal(frame.type, "error");
    assert.equal(frame.scope, "voice");
    assert.equal(frame.message, "voice.mode failed");
  });

  test("a held-mic recording is flagged as a voice note, with its measured duration", async () => {
    const upload = await fetch(`http://127.0.0.1:${adapter.port}/media?device=${DEVICE_ID}&token=${TOKEN}`, {
      method: "POST",
      headers: { "x-filename": "voice.m4a", "x-type": "audio", "x-thread-id": "vocal" },
      body: new Uint8Array([1, 2, 3, 4]),
    });
    const meta = (await upload.json()) as { id: string };

    client.ws.send(JSON.stringify({
      type: "chat.send", id: "v1", text: "", threadId: "vocal",
      attachments: [{ id: meta.id, type: "audio", audioAsVoice: true, durationMs: 4200 }],
    }));
    await waitUntil(() => received.length === 1);

    const att = received[0]!.attachments[0]!;
    assert.equal(att.type, "audio");
    // Without the flag the STT pass auto-detects the language instead of using the configured one.
    assert.equal(att.audioAsVoice, true);
    assert.equal(att.durationMs, 4200);
  });

  test("an .opus upload is stored as audio, not as a generic file", async () => {
    const upload = await fetch(`http://127.0.0.1:${adapter.port}/media?device=${DEVICE_ID}&token=${TOKEN}`, {
      method: "POST",
      headers: { "x-filename": "note.opus", "x-type": "audio", "x-thread-id": "opus" },
      body: new Uint8Array([9, 9, 9]),
    });
    const meta = (await upload.json()) as { id: string };

    client.ws.send(JSON.stringify({
      type: "chat.send", id: "o1", text: "", threadId: "opus",
      attachments: [{ id: meta.id, type: "audio" }],
    }));
    await waitUntil(() => received.length === 1);

    // Typed "file", it would never reach the transcription pass at all.
    assert.equal(received[0]!.attachments[0]!.type, "audio");
    assert.equal(received[0]!.attachments[0]!.mimeType, "audio/ogg");
  });

  test("a non-audio attachment cannot claim to be a voice note", async () => {
    const upload = await fetch(`http://127.0.0.1:${adapter.port}/media?device=${DEVICE_ID}&token=${TOKEN}`, {
      method: "POST",
      headers: { "x-filename": "photo.jpg", "x-type": "image", "x-thread-id": "claim" },
      body: new Uint8Array([1, 2]),
    });
    const meta = (await upload.json()) as { id: string };

    client.ws.send(JSON.stringify({
      type: "chat.send", id: "c1", text: "", threadId: "claim",
      attachments: [{ id: meta.id, type: "audio", audioAsVoice: true, durationMs: 999 }],
    }));
    await waitUntil(() => received.length === 1);

    const att = received[0]!.attachments[0]!;
    assert.equal(att.type, "image");
    assert.equal(att.audioAsVoice, undefined);
    assert.equal(att.durationMs, undefined);
  });

  test("session.delete takes the uploaded files with it", async () => {
    const port = adapter.port;
    const thread = "filedel";
    const upload = await fetch(`http://127.0.0.1:${port}/media?device=${DEVICE_ID}&token=${TOKEN}`, {
      method: "POST",
      headers: { "x-filename": "note.txt", "x-type": "file", "x-thread-id": thread },
      body: new Uint8Array([1, 2, 3]),
    });
    assert.equal(upload.status, 200);

    // The file is on disk, next to where its session would be.
    const filesDir = join(MY_CLAW_DIR, "files", "my-claw-app", DEVICE_ID, thread);
    assert.equal(existsSync(filesDir), true);

    client.ws.send(JSON.stringify({ type: "session.delete", threadId: thread }));
    // The reply only arrives once both removals have run: wait on it, not on the clock.
    const frame = (await nextFrame(client)) as { type: string };
    assert.equal(frame.type, "chat.history");
    assert.equal(existsSync(filesDir), false);
  });

  test("the app can pull a diagnostics snapshot and a filtered log tail", async () => {
    adapter.onDiagnostics({
      snapshot: async (deviceId, threadId) => `snapshot for ${deviceId}/${threadId}`,
      logs: async (query) => ({ text: `tail level=${query.level} run=${query.run} limit=${query.limit}`, lines: 3 }),
    });

    client.ws.send(JSON.stringify({ type: "diag.snapshot", threadId: "projet" }));
    const snap = (await nextFrame(client)) as { type: string; text: string };
    assert.equal(snap.type, "diag.snapshot.result");
    assert.equal(snap.text, `snapshot for ${DEVICE_ID}/projet`);

    client.ws.send(JSON.stringify({ type: "logs.tail", level: "warn", run: "aaaa1111", limit: 50 }));
    const tail = (await nextFrame(client)) as { type: string; text: string; lines: number; query: { run?: string } };
    assert.equal(tail.type, "logs.tail.result");
    assert.equal(tail.lines, 3);
    assert.equal(tail.query.run, "aaaa1111");
    assert.match(tail.text, /level=warn run=aaaa1111 limit=50/);
  });

  test("a diagnostics request without a provider answers an error instead of hanging", async () => {
    client.ws.send(JSON.stringify({ type: "diag.snapshot" }));
    const frame = (await nextFrame(client)) as { type: string; message: string };
    assert.equal(frame.type, "error");
    assert.match(frame.message, /diagnostics unavailable/);
  });

  test("the log tail limit is clamped, a client cannot ask for the whole file", async () => {
    let seen = 0;
    adapter.onDiagnostics({
      snapshot: async () => "",
      logs: async (query) => {
        seen = query.limit;
        return { text: "", lines: 0 };
      },
    });

    client.ws.send(JSON.stringify({ type: "logs.tail", limit: 999999 }));
    await nextFrame(client);
    assert.equal(seen, 1000);
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

  test("files.delete works for a device whose owner is not its id", async () => {
    // Storage is keyed by owner: passing the device id looked in a directory that never
    // exists, so every delete answered "file not found" and the file stayed.
    const owned = new MyClawAppAdapter(
      createConfig({ devices: { [DEVICE_ID]: { token: TOKEN, name: "test phone", owner: "neras" } } }),
      store as never,
    );
    owned.onMessage(async () => {});
    await owned.start();
    const client2 = await connectClient(owned.port);
    try {
      const upload = await fetch(`http://127.0.0.1:${owned.port}/media?device=${DEVICE_ID}&token=${TOKEN}`, {
        method: "POST",
        headers: { "x-filename": "vieux.pdf", "x-type": "file", "x-thread-id": "projet" },
        body: new Uint8Array([7, 7]),
      });
      const meta = (await upload.json()) as { id: string };

      client2.ws.send(JSON.stringify({ type: "files.delete", threadId: "projet", id: meta.id }));
      const frame = (await nextFrame(client2)) as { type: string; files?: unknown[]; message?: string };
      assert.equal(frame.type, "files.list.result");
      assert.equal(frame.files!.length, 0);

      // A refusal names the screen that asked, so the app shows it there instead of in the chat.
      client2.ws.send(JSON.stringify({ type: "files.delete", threadId: "projet", id: meta.id }));
      const refusal = (await nextFrame(client2)) as { type: string; message: string; scope: string };
      assert.equal(refusal.type, "error");
      assert.equal(refusal.message, "file not found");
      assert.equal(refusal.scope, "files");
    } finally {
      client2.ws.close();
      await owned.stop();
    }
  });

  test("archiving a session keeps its uploaded files", async () => {
    const upload = await fetch(`http://127.0.0.1:${adapter.port}/media?device=${DEVICE_ID}&token=${TOKEN}`, {
      method: "POST",
      headers: { "x-filename": "pic.png", "x-type": "image", "x-thread-id": "projet" },
      body: new Uint8Array([9, 9, 9]),
    });
    assert.equal(upload.status, 200);

    client.ws.send(JSON.stringify({ type: "session.archive", threadId: "projet" }));
    const ack = (await nextFrame(client)) as { type: string };
    assert.equal(ack.type, "session.list.result");
    // Unarchiving has to hand the conversation back whole, attachments included.
    client.ws.send(JSON.stringify({ type: "files.list", threadId: "projet" }));
    const list = (await nextFrame(client)) as { type: string; files: unknown[] };
    assert.equal(list.type, "files.list.result");
    assert.equal(list.files.length, 1);
  });

  test("a large upload is stored and served, with a warning only", async () => {
    const small = new MyClawAppAdapter(
      createConfig({ files: { warnSizeBytes: 4 } }),
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
      // Past the warning threshold: stored anyway, never refused.
      assert.equal(upload.status, 200);
      const meta = (await upload.json()) as { id: string; sizeBytes: number };
      assert.equal(meta.sizeBytes, 8);
      const got = await fetch(`http://127.0.0.1:${port}/media/${meta.id}?device=${DEVICE_ID}&token=${TOKEN}`);
      assert.equal(got.status, 200);
      assert.equal((await got.arrayBuffer()).byteLength, 8);
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

  test("session.history carries the cursor through and echoes it back with hasMore", async () => {
    store.historyMap.set("a", [
      { id: "h1", role: "user", text: "un", ts: "t1" },
      { id: "h2", role: "user", text: "deux", ts: "t2" },
      { id: "h3", role: "user", text: "trois", ts: "t3" },
    ]);
    client.ws.send(JSON.stringify({ type: "session.history", threadId: "a", limit: 1, before: 1 }));
    const frame = (await nextFrame(client)) as {
      type: string;
      messages: Array<{ text: string }>;
      before?: number;
      hasMore?: boolean;
    };
    assert.equal(frame.type, "chat.history");
    assert.deepEqual(store.historyCalls.at(-1), { limit: 1, before: 1 });
    // One back from the end, one message wide: the middle turn, with the first still behind it.
    assert.deepEqual(frame.messages.map((m) => m.text), ["deux"]);
    assert.equal(frame.before, 1);
    assert.equal(frame.hasMore, true);
  });

  test("session.history with an unsafe threadId returns an error frame", async () => {
    client.ws.send(JSON.stringify({ type: "session.history", threadId: "../x" }));
    const frame = (await nextFrame(client)) as { type: string };
    assert.equal(frame.type, "error");
  });

  test("session.archive files the thread away and replies with the refreshed listing", async () => {
    store.summaries = [
      { threadId: "a", title: "Infra", messageCount: 2, createdAt: "c", lastActiveAt: "l" },
    ];
    store.historyMap.set("a", [{ id: "h1", role: "user", text: "bonjour", ts: "t1" }]);

    client.ws.send(JSON.stringify({ type: "session.archive", threadId: "a" }));
    const frame = (await nextFrame(client)) as { type: string; sessions: Array<{ threadId: string; archived?: boolean }> };
    assert.equal(frame.type, "session.list.result");
    assert.equal(frame.sessions[0]!.archived, true);
    assert.deepEqual(store.archived, ["a"]);
    // Archiving is a flag: not one message may be dropped on the way.
    assert.equal(store.historyMap.get("a")!.length, 1);
  });

  test("session.unarchive brings the thread back to the main listing", async () => {
    store.summaries = [
      { threadId: "a", title: "Infra", messageCount: 2, createdAt: "c", lastActiveAt: "l", archived: true },
    ];

    client.ws.send(JSON.stringify({ type: "session.unarchive", threadId: "a" }));
    const frame = (await nextFrame(client)) as { type: string; sessions: Array<{ threadId: string; archived?: boolean }> };
    assert.equal(frame.type, "session.list.result");
    assert.equal(frame.sessions[0]!.archived, undefined);
    assert.deepEqual(store.unarchived, ["a"]);
  });

  test("session.unarchive with an unsafe threadId returns an error frame", async () => {
    client.ws.send(JSON.stringify({ type: "session.unarchive", threadId: "../x" }));
    const frame = (await nextFrame(client)) as { type: string };
    assert.equal(frame.type, "error");
  });

  test("session.pin ranks the thread and every device of the owner is told", async () => {
    store.summaries = [
      { threadId: "a", title: "Infra", messageCount: 2, createdAt: "c", lastActiveAt: "l" },
      { threadId: "b", title: "Courses", messageCount: 1, createdAt: "c", lastActiveAt: "l" },
    ];
    // Two devices, one owner: the phone and the browser are what this feature exists for.
    const shared = new MyClawAppAdapter(
      createConfig({
        devices: {
          [DEVICE_ID]: { token: TOKEN, name: "test phone", owner: "neras" },
          "dev-web": { token: TOKEN, name: "test browser", owner: "neras" },
        },
      }),
      store as never,
    );
    shared.onMessage(async () => {});
    await shared.start();
    const phone = await connectClient(shared.port);
    const browser = await connectClient(shared.port, "dev-web");
    try {
      phone.ws.send(JSON.stringify({ type: "session.pin", threadId: "a", pinned: true }));

      const own = (await nextFrame(phone)) as { type: string; sessions: Array<{ threadId: string; pinRank?: number }> };
      assert.equal(own.type, "session.list.result");
      assert.equal(own.sessions[0]!.pinRank, 0);
      assert.deepEqual(store.pinCalls, [{ threadId: "a", pinned: true }]);
      // The pin belongs to the owner, so the other client's drawer moves with it.
      const echoed = (await nextFrame(browser)) as { type: string; sessions: Array<{ threadId: string; pinRank?: number }> };
      assert.equal(echoed.type, "session.list.result");
      assert.equal(echoed.sessions[0]!.pinRank, 0);
    } finally {
      phone.ws.close();
      browser.ws.close();
      await shared.stop();
    }
  });

  test("session.pin.order hands the dropped order to the store", async () => {
    store.summaries = [
      { threadId: "a", title: "Infra", messageCount: 2, createdAt: "c", lastActiveAt: "l", pinRank: 0 },
      { threadId: "b", title: "Courses", messageCount: 1, createdAt: "c", lastActiveAt: "l", pinRank: 1 },
    ];

    client.ws.send(JSON.stringify({ type: "session.pin.order", threadIds: ["b", "a"] }));

    const frame = (await nextFrame(client)) as { type: string; sessions: Array<{ threadId: string; pinRank?: number }> };
    assert.equal(frame.type, "session.list.result");
    assert.deepEqual(store.pinOrders, [["b", "a"]]);
    assert.equal(frame.sessions.find((entry) => entry.threadId === "b")!.pinRank, 0);
    assert.equal(frame.sessions.find((entry) => entry.threadId === "a")!.pinRank, 1);
  });

  test("session.pin with an unsafe threadId returns an error frame", async () => {
    client.ws.send(JSON.stringify({ type: "session.pin", threadId: "../x", pinned: true }));
    const frame = (await nextFrame(client)) as { type: string };
    assert.equal(frame.type, "error");
    assert.deepEqual(store.pinCalls, []);
  });

  test("session.pin on a conversation that does not exist is refused, not silent", async () => {
    store.summaries = [];
    client.ws.send(JSON.stringify({ type: "session.pin", threadId: "ghost", pinned: true }));
    const frame = (await nextFrame(client)) as { type: string; scope: string };
    assert.equal(frame.type, "error");
    assert.equal(frame.scope, "session");
  });

  test("session.delete removes the thread", async () => {
    client.ws.send(JSON.stringify({ type: "session.delete", threadId: "a" }));
    await nextFrame(client);
    assert.deepEqual(store.removed, ["a"]);
  });

  test("confirmTool sends approval.request and accepts a response", async () => {
    const approvalsAdapter = new MyClawAppAdapter(createConfig({ approvals: true }), store as never);
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
    const approvalsAdapter = new MyClawAppAdapter(createConfig({ approvals: true }), store as never);
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
    const probe = await fetch(`http://127.0.0.1:${port}/my-claw-app`).catch(() => null);
    assert.equal(probe, null);
  });
});

describe("MyClawAppAdapter owners", () => {
  // A phone and a browser paired to the same owner are two windows onto one conversation:
  // same thread namespace, same files, and an answer has to land on both.
  const OWNER = "neras";
  let adapter: MyClawAppAdapter;
  let store: FakeSessionStore & { listedFor: string[] };
  let received: UnifiedMessage[];

  beforeEach(async () => {
    const base = new FakeSessionStore() as FakeSessionStore & { listedFor: string[] };
    base.listedFor = [];
    base.list = async (key: string) => {
      base.listedFor.push(key);
      return base.summaries;
    };
    store = base;
    adapter = new MyClawAppAdapter(
      {
        port: 0,
        devices: {
          phone: { token: TOKEN, owner: OWNER },
          browser: { token: TOKEN, owner: OWNER },
          loner: { token: TOKEN },
        },
        streaming: { enabled: true, minChars: 1 },
      },
      store as never,
    );
    received = [];
    adapter.onMessage(async (msg) => {
      received.push(msg);
    });
    await adapter.start();
  });

  afterEach(async () => {
    await adapter.stop();
  });

  test("devices of one owner share the conversation and both receive the reply", async () => {
    const phone = await connectClient(adapter.port, "phone");
    const browser = await connectClient(adapter.port, "browser");

    phone.ws.send(JSON.stringify({ type: "chat.send", id: "m1", text: "from the phone", threadId: "t-1" }));
    await waitUntil(() => received.length > 0);
    assert.equal(received[0]?.chatId, OWNER, "the message must be keyed by owner, not by device");
    assert.equal(received[0]?.userId, OWNER);
    // The prompt reaches the other window before anything answers it.
    assert.equal((await nextFrame(browser))["type"], "chat.user");

    browser.ws.send(JSON.stringify({ type: "session.list", id: "s1" }));
    await nextFrame(browser);
    assert.deepEqual(store.listedFor, [OWNER], "the browser must read the owner's thread list");

    await adapter.send(OWNER, { text: "answered", threadId: "t-1" });
    const onPhone = await nextFrame(phone);
    const onBrowser = await nextFrame(browser);
    assert.equal(onPhone["text"], "answered");
    assert.equal(onBrowser["text"], "answered");

    phone.ws.close();
    browser.ws.close();
  });

  // Before this, the window that was not typing had no question to hang the answer on: the
  // stream drew its bubble at the end of the thread, under nothing, until a reload from disk.
  test("a prompt reaches the owner's other window, under the sender's own bubble id", async () => {
    const phone = await connectClient(adapter.port, "phone");
    const browser = await connectClient(adapter.port, "browser");
    try {
      phone.ws.send(JSON.stringify({ type: "chat.send", id: "m1", text: "  from the phone  ", threadId: "t-1" }));

      const echo = await nextFrame(browser);
      assert.equal(echo["type"], "chat.user");
      assert.equal(echo["threadId"], "t-1");
      // The sender's id: the browser keys the bubble the same way, so a history page merged over
      // it later recognises the turn instead of duplicating it.
      assert.equal(echo["id"], "m1");
      assert.equal(echo["text"], "from the phone");

      // Nothing goes back to the window that typed it: it drew that bubble on send.
      await adapter.send(OWNER, { text: "answered", threadId: "t-1" });
      assert.equal((await nextFrame(phone))["type"], "chat.message");
    } finally {
      phone.ws.close();
      browser.ws.close();
    }
  });

  test("a slash command is mirrored too, before the answer that quotes it", async () => {
    adapter.onCommandHandler(async () => "done");
    const phone = await connectClient(adapter.port, "phone");
    const browser = await connectClient(adapter.port, "browser");
    try {
      phone.ws.send(JSON.stringify({ type: "chat.send", id: "c1", text: "/status", threadId: "t-1" }));

      const echo = await nextFrame(browser);
      assert.equal(echo["type"], "chat.user");
      assert.equal(echo["text"], "/status");
      // The order is load-bearing: the answer quotes the bubble the echo just created.
      const answer = await nextFrame(browser);
      assert.equal(answer["type"], "chat.command.result");
      assert.equal(answer["replyToId"], "c1");
    } finally {
      phone.ws.close();
      browser.ws.close();
    }
  });

  // The hold is the longest silence the app ever shows (a compaction runs for minutes), so it is
  // the moment a second window most needs to know a message is in flight at all.
  test("a send parked behind a compaction is marked on both screens", async () => {
    const phone = await connectClient(adapter.port, "phone");
    const browser = await connectClient(adapter.port, "browser");
    try {
      phone.ws.send(JSON.stringify({ type: "chat.send", id: "m1", text: "pendant la compaction", threadId: "t-1" }));
      // The bubble reaches the other window first: the mark names it by the sender's id, and a
      // mark landing on a bubble that does not exist yet marks nothing at all.
      assert.equal((await nextFrame(browser))["type"], "chat.user");

      adapter.notifyQueued(OWNER, "t-1", "m1", "compaction");
      for (const window of [phone, browser]) {
        const queued = await nextFrame(window);
        assert.equal(queued["type"], "chat.send.queued");
        assert.equal(queued["replyToId"], "m1");
        assert.equal(queued["reason"], "compaction");
      }
    } finally {
      phone.ws.close();
      browser.ws.close();
    }
  });

  test("a device without an owner stays on its own namespace", async () => {
    const loner = await connectClient(adapter.port, "loner");
    const phone = await connectClient(adapter.port, "phone");

    loner.ws.send(JSON.stringify({ type: "chat.send", id: "m2", text: "solo", threadId: "t-1" }));
    await waitUntil(() => received.length > 0);
    assert.equal(received[0]?.chatId, "loner");

    await adapter.send("loner", { text: "for the loner", threadId: "t-1" });
    const onLoner = await nextFrame(loner);
    assert.equal(onLoner["text"], "for the loner");
    assert.equal(phone.frames.length, 0, "another owner must not see it");

    loner.ws.close();
    phone.ws.close();
  });

  test("a window that joins mid-answer still gets the rest of the stream", async () => {
    const phone = await connectClient(adapter.port, "phone");
    const streamer = adapter.createStreamer(streamerMessage(adapter, "m3", OWNER));
    await streamer.push("first ");
    await nextFrame(phone);

    const browser = await connectClient(adapter.port, "browser");
    await streamer.push("second");
    await streamer.finish();

    const late = await nextFrame(browser);
    assert.ok(String(late["type"]).startsWith("chat.stream."), "the late window must receive the remaining frames");

    phone.ws.close();
    browser.ws.close();
  });
});

/**
 * A change is a fact about the owner, not about the window that made it. What answers a *read*
 * still goes to the asker alone, which is the line these tests draw (docs/my-claw-app-channel.md).
 */
describe("a mutation reaches every window of the owner", () => {
  const OWNER = "neras";
  let adapter: MyClawAppAdapter;
  let store: FakeSessionStore;
  let phone: WsClient;
  let browser: WsClient;

  beforeEach(async () => {
    store = new FakeSessionStore();
    store.summaries = [{ threadId: "projet", title: "salut", messageCount: 2, createdAt: "c", lastActiveAt: "l" }];
    adapter = new MyClawAppAdapter(
      {
        port: 0,
        devices: { phone: { token: TOKEN, owner: OWNER }, browser: { token: TOKEN, owner: OWNER } },
        streaming: { enabled: true, minChars: 1 },
      },
      store as never,
    );
    adapter.onMessage(async () => {});
    adapter.onTagsController({
      list: () => ({ type: "tags.result", tags: [{ name: "Default", model: "fast-1" }] }),
      upsert: async (fields) => ({ type: "tags.result", tags: [{ name: fields.name, model: fields.model }] }),
      delete: async () => ({ type: "tags.result", tags: [] }),
    });
    adapter.onToolsController({
      list: () => ({ tools: [{ name: "bash", description: "Run", source: "built-in", disabled: false }], missing: [] }),
      toggle: async (name, disabled) => ({ tools: [{ name, description: "Run", source: "built-in", disabled }], missing: [] }),
    });
    let mode: "cloud" | "local" | "auto" = "auto";
    adapter.onVoiceController({
      status: () => ({ mode, resolved: mode === "local" ? "local" : "cloud", cloudAvailable: true }),
      setMode: async (next) => { mode = next; },
    });
    await adapter.start();
    phone = await connectClient(adapter.port, "phone");
    browser = await connectClient(adapter.port, "browser");
  });

  afterEach(async () => {
    phone.ws.close();
    browser.ws.close();
    await adapter.stop();
  });

  test("a conversation renamed, filed or deleted moves on both screens", async () => {
    phone.ws.send(JSON.stringify({ type: "session.rename", threadId: "projet", title: "Infra maison" }));
    assert.equal((await nextFrame(phone))["type"], "session.list.result");
    const renamed = await nextFrame(browser);
    assert.equal(renamed["type"], "session.list.result");
    assert.equal((renamed["sessions"] as Array<{ title: string }>)[0]?.title, "Infra maison");

    phone.ws.send(JSON.stringify({ type: "session.archive", threadId: "projet" }));
    assert.equal((await nextFrame(phone))["type"], "session.list.result");
    assert.equal((await nextFrame(browser))["type"], "session.list.result");

    phone.ws.send(JSON.stringify({ type: "session.delete", threadId: "projet" }));
    // The other window drops the bubbles of a conversation that no longer exists, then its row.
    assert.equal((await nextFrame(browser))["type"], "chat.cleared");
    assert.equal((await nextFrame(browser))["type"], "session.list.result");
  });

  test("a file deleted from one window leaves the other window's explorer", async () => {
    const upload = await fetch(`http://127.0.0.1:${adapter.port}/media?device=phone&token=${TOKEN}`, {
      method: "POST",
      headers: { "x-filename": "note.pdf", "x-type": "file", "x-thread-id": "projet" },
      body: new Uint8Array([1, 2, 3]),
    });
    const meta = (await upload.json()) as { id: string };

    // A read is the asker's business: the browser hears nothing about it.
    phone.ws.send(JSON.stringify({ type: "files.list", threadId: "projet" }));
    assert.equal((await nextFrame(phone))["type"], "files.list.result");
    assert.equal(browser.frames.length, 0);

    phone.ws.send(JSON.stringify({ type: "files.delete", threadId: "projet", id: meta.id }));
    const mirrored = await nextFrame(browser);
    assert.equal(mirrored["type"], "files.list.result");
    assert.equal((mirrored["files"] as unknown[]).length, 0);
  });

  test("a tag, a tool and the voice engine are shared state, a read is not", async () => {
    phone.ws.send(JSON.stringify({ type: "tags.upsert", name: "sonnet", model: "claude-sonnet-5" }));
    assert.equal((await nextFrame(browser))["type"], "tags.result");

    phone.ws.send(JSON.stringify({ type: "tools.toggle", name: "bash", disabled: true }));
    const tools = await nextFrame(browser);
    assert.equal(tools["type"], "tools.list.result");
    assert.equal((tools["tools"] as Array<{ disabled: boolean }>)[0]?.disabled, true);

    phone.ws.send(JSON.stringify({ type: "voice.mode.set", mode: "local" }));
    assert.equal((await nextFrame(browser))["resolved"], "local");

    // Reads of the same three surfaces answer the asker and nobody else.
    browser.frames.length = 0;
    phone.ws.send(JSON.stringify({ type: "tags.list" }));
    phone.ws.send(JSON.stringify({ type: "tools.list" }));
    phone.ws.send(JSON.stringify({ type: "voice.mode.get" }));
    await waitUntil(() => phone.frames.length >= 3);
    assert.equal(browser.frames.length, 0, "a read must not travel to the other windows");
  });

  test("the workspace of a conversation is the conversation's, not the device's", async () => {
    phone.ws.send(JSON.stringify({ type: "session.workspace.set", threadId: "projet", workspace: "sofa" }));
    const mirrored = await nextFrame(browser);
    assert.equal(mirrored["type"], "session.workspace.set.result");
    assert.equal(mirrored["workspace"], "sofa");
  });
});

describe("model frames", () => {
  let adapter: MyClawAppAdapter;
  let client: WsClient;
  let store: FakeSessionStore;

  beforeEach(async () => {
    store = new FakeSessionStore();
    adapter = new MyClawAppAdapter(createConfig(), store as never);
    adapter.onModelController({
      list: () => ({
        models: [
          { id: "fast-1", label: "Fast", group: "Fast/Standard" },
          { id: "strong-2", label: "Strong", group: "Strong/Advanced" },
        ],
        defaultModel: "fast-1",
        unavailable: [],
      }),
      endpoints: async () => [{ id: "fast-1@azure/eu", label: "Azure (azure/eu)", promptUsd: 0.22 }],
      current: async () => ({ model: "fast-1", defaultModel: "fast-1", effort: { level: "", levels: [], supported: false }, context: { raw: 200000, effective: 200000 } }),
      set: async () => ({ model: "strong-2", defaultModel: "fast-1", effort: { level: "", levels: [], supported: false }, context: { raw: 200000, effective: 200000 } }),
      setEffort: async () => ({ model: "strong-2", defaultModel: "fast-1", effort: { level: "medium", levels: ["low", "medium", "high"], supported: true }, context: { raw: 200000, effective: 200000 } }),
      setContext: async (_o, _t, choice) => ({ model: "strong-2", defaultModel: "fast-1", effort: { level: "", levels: [], supported: false }, context: { raw: 200000, effective: choice === "full" ? 200000 : choice, ...(choice === "full" ? {} : { choice }) } }),
    });
    await adapter.start();
    client = await connectClient(adapter.port);
  });

  afterEach(async () => {
    client.ws.close();
    await adapter.stop();
  });

  test("model.list answers with the catalog and the default", async () => {
    client.ws.send(JSON.stringify({ type: "model.list" }));
    const frame = await nextFrame(client);
    assert.equal(frame["type"], "model.list.result");
    assert.equal((frame["models"] as Array<{ id: string }>).length, 2);
    assert.equal(frame["defaultModel"], "fast-1");
  });

  test("model.refresh re-runs discovery, then sends the listing before the outcome", async () => {
    const refreshed = new MyClawAppAdapter(createConfig(), store as never);
    let discoveries = 0;
    refreshed.onModelController({
      list: () => ({
        models: discoveries === 0
          ? [{ id: "fast-1", label: "Fast" }]
          : [{ id: "fast-1", label: "Fast" }, { id: "just-appeared", label: "New" }],
        defaultModel: "fast-1",
        unavailable: [],
      }),
      refresh: async () => {
        discoveries += 1;
        return { models: 2, failed: ["groq"], enabled: true };
      },
      endpoints: async () => [],
      current: async () => ({ model: "fast-1", defaultModel: "fast-1", effort: { level: "", levels: [], supported: false }, context: { raw: 200000, effective: 200000 } }),
      set: async () => ({ model: "fast-1", defaultModel: "fast-1", effort: { level: "", levels: [], supported: false }, context: { raw: 200000, effective: 200000 } }),
      setEffort: async () => ({ model: "fast-1", defaultModel: "fast-1", effort: { level: "", levels: [], supported: false }, context: { raw: 200000, effective: 200000 } }),
      setContext: async () => ({ model: "fast-1", defaultModel: "fast-1", effort: { level: "", levels: [], supported: false }, context: { raw: 200000, effective: 200000 } }),
    });
    await refreshed.start();
    const asking = await connectClient(refreshed.port);
    try {
      asking.ws.send(JSON.stringify({ type: "model.refresh" }));

      // The listing first: the screen must already show the new catalogue when the outcome line
      // appears under it, not one frame later.
      const listing = (await nextFrame(asking)) as { type: string; models: Array<{ id: string }> };
      assert.equal(listing.type, "model.list.result");
      assert.deepEqual(listing.models.map((m) => m.id), ["fast-1", "just-appeared"]);

      const outcome = (await nextFrame(asking)) as { type: string; models: number; failed: string[]; enabled: boolean };
      assert.equal(outcome.type, "model.refresh.result");
      assert.equal(outcome.models, 2);
      // A provider that could not be reached is named: its old models are still listed, and
      // silence would read as "nothing new" instead of "one provider did not answer".
      assert.deepEqual(outcome.failed, ["groq"]);
      assert.equal(discoveries, 1);
    } finally {
      asking.ws.close();
      await refreshed.stop();
    }
  });

  test("model.refresh on a server with no discovery to run is refused, not answered", async () => {
    // The controller of this suite has no `refresh`: an older entry point, or a build with no
    // catalogue at all. A silent success would show the button working and change nothing.
    client.ws.send(JSON.stringify({ type: "model.refresh" }));
    const frame = (await nextFrame(client)) as { type: string; scope: string };
    assert.equal(frame.type, "error");
    assert.equal(frame.scope, "model");
  });

  // The routes of one model are asked for when a menu opens on it, never for the catalogue: it is
  // one HTTP call per model and there are four hundred of them.
  test("model.endpoints answers with the routes of one model", async () => {
    client.ws.send(JSON.stringify({ type: "model.endpoints", model: "fast-1" }));
    const frame = await nextFrame(client);
    assert.equal(frame["type"], "model.endpoints.result");
    assert.equal(frame["model"], "fast-1");
    const routes = frame["endpoints"] as Array<{ id: string; label: string }>;
    assert.equal(routes.length, 1);
    assert.equal(routes[0]!.id, "fast-1@azure/eu");
  });

  test("model.list passes the provider key through for the app to group by", async () => {
    store = new FakeSessionStore();
    const withProviders = new MyClawAppAdapter(createConfig(), store as never);
    withProviders.onModelController({
      list: () => ({
        models: [
          { id: "fast-1", label: "Fast", provider: "litellm" },
          { id: "naked", label: "Naked" },
        ],
        defaultModel: "fast-1",
        unavailable: [],
      }),
      endpoints: async () => [],
      current: async () => ({ model: "fast-1", defaultModel: "fast-1", effort: { level: "", levels: [], supported: false }, context: { raw: 200000, effective: 200000 } }),
      set: async () => ({ model: "fast-1", defaultModel: "fast-1", effort: { level: "", levels: [], supported: false }, context: { raw: 200000, effective: 200000 } }),
      setEffort: async () => ({ model: "fast-1", defaultModel: "fast-1", effort: { level: "", levels: [], supported: false }, context: { raw: 200000, effective: 200000 } }),
      setContext: async () => ({ model: "fast-1", defaultModel: "fast-1", effort: { level: "", levels: [], supported: false }, context: { raw: 200000, effective: 200000 } }),
    });
    await withProviders.start();
    try {
      const c = await connectClient(withProviders.port);
      c.ws.send(JSON.stringify({ type: "model.list" }));
      const frame = await nextFrame(c);
      const models = frame["models"] as Array<{ id: string; provider?: string }>;
      assert.equal(models[0]!["provider"], "litellm");
      assert.equal(models[1]!["provider"], undefined);
      c.ws.close();
    } finally {
      await withProviders.stop();
    }
  });

  test("models.upsert writes the declaration and answers with the fresh catalogue", async () => {
    store = new FakeSessionStore();
    const editable = new MyClawAppAdapter(createConfig(), store as never);
    const written: Array<Record<string, unknown>> = [];
    const declared: Array<{ id: string; label: string; declared?: boolean }> = [{ id: "fast-1", label: "Fast" }];
    editable.onModelController({
      list: () => ({ models: declared, defaultModel: "fast-1", unavailable: [] }),
      endpoints: async () => [],
      current: async () => ({ model: "fast-1", defaultModel: "fast-1", effort: { level: "", levels: [], supported: false }, context: { raw: 200000, effective: 200000 } }),
      set: async () => ({ model: "fast-1", defaultModel: "fast-1", effort: { level: "", levels: [], supported: false }, context: { raw: 200000, effective: 200000 } }),
      setEffort: async () => ({ model: "fast-1", defaultModel: "fast-1", effort: { level: "", levels: [], supported: false }, context: { raw: 200000, effective: 200000 } }),
      setContext: async () => ({ model: "fast-1", defaultModel: "fast-1", effort: { level: "", levels: [], supported: false }, context: { raw: 200000, effective: 200000 } }),
      upsert: async (entry) => {
        written.push(entry as unknown as Record<string, unknown>);
        declared.push({ id: entry.id, label: entry.label ?? entry.id, declared: true });
      },
      remove: async (id) => {
        declared.splice(declared.findIndex((m) => m.id === id), 1);
      },
    });
    await editable.start();
    try {
      const c = await connectClient(editable.port);
      c.ws.send(JSON.stringify({ type: "models.upsert", id: "litellm/new", label: "New", provider: "litellm", context: 200000 }));
      const frame = await nextFrame(c);
      assert.equal(frame["type"], "model.list.result");
      assert.equal(written.length, 1);
      assert.equal(written[0]!["context"], 200000);
      const models = frame["models"] as Array<{ id: string }>;
      assert.equal(models.length, 2);
      assert.equal(models[1]!.id, "litellm/new");

      c.ws.send(JSON.stringify({ type: "models.remove", id: "litellm/new" }));
      const after = await nextFrame(c);
      assert.equal(after["type"], "model.list.result");
      assert.equal((after["models"] as unknown[]).length, 1);
      c.ws.close();
    } finally {
      await editable.stop();
    }
  });

  test("models.upsert is refused when the controller cannot write config", async () => {
    // The read-only controller of this suite has no upsert: a refusal, never a silent success.
    client.ws.send(JSON.stringify({ type: "models.upsert", id: "litellm/new" }));
    const frame = await nextFrame(client);
    assert.equal(frame["type"], "error");
    assert.equal(frame["scope"], "model");
  });

  test("model.set refuses an id the server does not know", async () => {
    client.ws.send(JSON.stringify({ type: "model.set", threadId: "t1", model: "ghost-model" }));
    const frame = await nextFrame(client);
    assert.equal(frame["type"], "error");
    assert.equal(frame["scope"], "model");
  });

  // The routing step of the chained picker rewrites the staged model into `model@tag`, so the
  // guard has to read the model under the pin or the whole flow ends on "unknown model".
  test("model.set accepts a route pinned on a model it knows", async () => {
    client.ws.send(JSON.stringify({ type: "model.set", threadId: "t1", model: "fast-1@azure/eu" }));
    const frame = await nextFrame(client);
    assert.equal(frame["type"], "model.result");
    assert.equal(frame["threadId"], "t1");
  });

  test("model.set still refuses a route pinned on a model it does not know", async () => {
    client.ws.send(JSON.stringify({ type: "model.set", threadId: "t1", model: "ghost-model@azure/eu" }));
    const frame = await nextFrame(client);
    assert.equal(frame["type"], "error");
    assert.equal(frame["scope"], "model");
  });

  test("model.set answers with the state the server stored", async () => {
    client.ws.send(JSON.stringify({ type: "model.set", threadId: "t1", model: "strong-2" }));
    const frame = await nextFrame(client);
    assert.equal(frame["type"], "model.result");
    assert.equal(frame["model"], "strong-2");
    assert.equal(frame["threadId"], "t1");
  });

  test("model.context.set stores the ceiling and answers with the state", async () => {
    client.ws.send(JSON.stringify({ type: "model.context.set", threadId: "t1", choice: 128000 }));
    const frame = await nextFrame(client);
    assert.equal(frame["type"], "model.result");
    assert.deepEqual(frame["context"], { raw: 200000, effective: 128000, choice: 128000 });
  });

  test("model.context.set accepts full, the model's own window", async () => {
    client.ws.send(JSON.stringify({ type: "model.context.set", threadId: "t1", choice: "full" }));
    const frame = await nextFrame(client);
    assert.equal(frame["type"], "model.result");
    assert.deepEqual(frame["context"], { raw: 200000, effective: 200000 });
  });

  test("model.context.set refuses a ceiling that is not a positive number", async () => {
    client.ws.send(JSON.stringify({ type: "model.context.set", threadId: "t1", choice: 0 }));
    const frame = await nextFrame(client);
    assert.equal(frame["type"], "error");
    assert.equal(frame["scope"], "model");
  });

  test("model.effort.set answers with the resulting state", async () => {
    client.ws.send(JSON.stringify({ type: "model.effort.set", threadId: "t1", level: "medium" }));
    const frame = await nextFrame(client);
    assert.equal(frame["type"], "model.result");
    assert.equal((frame["effort"] as { level: string }).level, "medium");
  });

  test("a mid-run push sends the same state, unasked", async () => {
    await adapter.notifyModelState(DEVICE_ID, "t1");
    const frame = await nextFrame(client);
    assert.equal(frame["type"], "model.result");
    assert.equal(frame["threadId"], "t1");
    assert.equal(frame["model"], "fast-1");
  });

  test("a model pick reaches every device of the owner, not just the one that picked", async () => {
    const shared = new MyClawAppAdapter(
      createConfig({
        devices: {
          [DEVICE_ID]: { token: TOKEN, name: "test phone", owner: "neras" },
          "dev-web": { token: TOKEN, name: "test browser", owner: "neras" },
        },
      }),
      store as never,
    );
    shared.onModelController({
      list: () => ({ models: [{ id: "fast-1", label: "Fast" }, { id: "strong-2", label: "Strong" }], defaultModel: "fast-1", unavailable: [] }),
      endpoints: async () => [],
      current: async () => ({ model: "fast-1", defaultModel: "fast-1", effort: { level: "", levels: [], supported: false }, context: { raw: 200000, effective: 200000 } }),
      set: async () => ({ model: "strong-2", defaultModel: "fast-1", effort: { level: "", levels: [], supported: false }, context: { raw: 200000, effective: 200000 } }),
      setEffort: async () => ({ model: "strong-2", defaultModel: "fast-1", effort: { level: "high", levels: ["high"], supported: true }, context: { raw: 200000, effective: 200000 } }),
      setContext: async () => ({ model: "strong-2", defaultModel: "fast-1", effort: { level: "", levels: [], supported: false }, context: { raw: 200000, effective: 128000, choice: 128000 } }),
    });
    await shared.start();
    const phone = await connectClient(shared.port);
    const browser = await connectClient(shared.port, "dev-web");
    try {
      phone.ws.send(JSON.stringify({ type: "model.set", threadId: "t1", model: "strong-2" }));
      const own = await nextFrame(phone);
      assert.equal(own["model"], "strong-2");
      // The pick belongs to the thread, so the browser left open on it hears about it too.
      const echoed = await nextFrame(browser);
      assert.equal(echoed["type"], "model.result");
      assert.equal(echoed["model"], "strong-2");
      assert.equal(echoed["threadId"], "t1");
    } finally {
      phone.ws.close();
      browser.ws.close();
      await shared.stop();
    }
  });

  test("a session id of this channel addresses the push, a foreign one is skipped", async () => {
    adapter.notifyModelStateForSession(`my-claw-app/thread/${DEVICE_ID}/t1`);
    const frame = await nextFrame(client);
    assert.equal(frame["type"], "model.result");
    assert.equal(frame["threadId"], "t1");

    // Another channel's session, and a sub-agent run the app merely displays, own no header here.
    adapter.notifyModelStateForSession("telegram/dm/u1");
    adapter.notifyModelStateForSession("subagent/run-1234");
    client.ws.send(JSON.stringify({ type: "model.list" }));
    const next = await nextFrame(client);
    assert.equal(next["type"], "model.list.result");
  });

  test("a push whose state cannot be read reaches neither the client nor the caller", async () => {
    const failing = new MyClawAppAdapter(createConfig(), store as never);
    failing.onModelController({
      list: () => ({ models: [{ id: "fast-1", label: "Fast" }], defaultModel: "fast-1", unavailable: [] }),
      endpoints: async () => [],
      current: async () => {
        throw new Error("session unreadable");
      },
      set: async () => ({ model: "fast-1", defaultModel: "fast-1", effort: { level: "", levels: [], supported: false }, context: { raw: 200000, effective: 200000 } }),
      setEffort: async () => ({ model: "fast-1", defaultModel: "fast-1", effort: { level: "", levels: [], supported: false }, context: { raw: 200000, effective: 200000 } }),
      setContext: async () => ({ model: "fast-1", defaultModel: "fast-1", effort: { level: "", levels: [], supported: false }, context: { raw: 200000, effective: 200000 } }),
    });
    await failing.start();
    const other = await connectClient(failing.port);
    try {
      await failing.notifyModelState(DEVICE_ID, "t1");
      // Nothing queued ahead of it: the next answer is the one this asks for, not a stale push.
      other.ws.send(JSON.stringify({ type: "model.list" }));
      const frame = await nextFrame(other);
      assert.equal(frame["type"], "model.list.result");
    } finally {
      other.ws.close();
      await failing.stop();
    }
  });
});

describe("agents frames", () => {
  let adapter: MyClawAppAdapter;
  let client: WsClient;
  let store: FakeSessionStore;
  const SNAPSHOT: MyClawAppAgentsConfigResult = {
    type: "agents.config.result",
    defaultModel: "fast-1",
    defaultProvider: "prov-a",
    defaultEffort: "high",
    effortLevels: ["low", "medium", "high"],
    fallback: "fast-1",
    providers: [{ key: "prov-a", type: "openai", discover: true, models: 2, keyEnv: "PROV_A_KEY", keyPresent: true }],
    agents: [
      { key: "orchestrator", label: "Orchestrator", description: "The agent you talk to", model: "fast-1", pinned: false, inheritsFrom: "global" },
      { key: "cron", label: "Scheduled tasks", description: "Jobs on a schedule", model: "fast-1", pinned: false, inheritsFrom: "orchestrator" },
    ],
  };

  beforeEach(async () => {
    store = new FakeSessionStore();
    adapter = new MyClawAppAdapter(createConfig(), store as never);
    adapter.onAgentsController({
      get: () => SNAPSHOT,
      setModel: async (agent, modelId, effort) => ({
        ...SNAPSHOT,
        defaultModel: modelId,
        defaultEffort: effort ?? SNAPSHOT.defaultEffort,
        agents: SNAPSHOT.agents,
      }),
      clearModel: async (agent) => ({ ...SNAPSHOT, agents: SNAPSHOT.agents.map((a) => ({ ...a, pinned: false })) }),
      setFallback: async (model) => ({ ...SNAPSHOT, fallback: model }),
      setScope: async (agent, field, mode, names) => ({ ...SNAPSHOT, agents: SNAPSHOT.agents.map((a) => (a.key === agent ? { ...a, [field]: mode === "inherit" ? null : mode === "all" ? ["*"] : names } : a)) }),
      setWorkspace: async (agent, workspace) => ({ ...SNAPSHOT, agents: SNAPSHOT.agents.map((a) => (a.key === agent ? { ...a, workspace } : a)) }),
      setMaxIterations: async (agent, value) => ({ ...SNAPSHOT, agents: SNAPSHOT.agents.map((a) => (a.key === agent ? { ...a, maxIterations: value } : a)) }),
      setContextCap: async (agent, value) => ({ ...SNAPSHOT, agents: SNAPSHOT.agents.map((a) => (a.key === agent ? { ...a, contextCap: value } : a)) }),
      fileGet: async () => null,
      fileSet: async (agent, fields) => {
        throw new Error("no file for reserved roles");
      },
      fileCreate: async (name, description) => {
        throw new Error("nope");
      },
      fileDelete: async (agent) => {
        throw new Error("nope");
      },
    });
    await adapter.start();
    client = await connectClient(adapter.port);
  });

  afterEach(async () => {
    client.ws.close();
    await adapter.stop();
  });

  test("agents.config.get answers with the whole snapshot", async () => {
    client.ws.send(JSON.stringify({ type: "agents.config.get" }));
    const frame = await nextFrame(client);
    assert.equal(frame["type"], "agents.config.result");
    assert.equal(frame["defaultModel"], "fast-1");
    assert.equal((frame["agents"] as unknown[]).length, 2);
    assert.equal((frame["providers"] as unknown[]).length, 1);
  });

  test("agents.model.set forwards agent and model and answers with the stored state", async () => {
    client.ws.send(JSON.stringify({ type: "agents.model.set", agent: "cron", model: "strong-2" }));
    const frame = await nextFrame(client);
    assert.equal(frame["type"], "agents.config.result");
    assert.equal(frame["defaultModel"], "strong-2");
  });

  test("agents.model.set refuses a missing controller with the agents scope", async () => {
    const bare = new MyClawAppAdapter(createConfig(), store as never);
    await bare.start();
    try {
      const c = await connectClient(bare.port);
      c.ws.send(JSON.stringify({ type: "agents.model.set", agent: "cron", model: "strong-2" }));
      const frame = await nextFrame(c);
      assert.equal(frame["type"], "error");
      assert.equal(frame["scope"], "agents");
      c.ws.close();
    } finally {
      await bare.stop();
    }
  });

  test("agents.model.clear answers with the unpinned state", async () => {
    client.ws.send(JSON.stringify({ type: "agents.model.clear", agent: "cron" }));
    const frame = await nextFrame(client);
    assert.equal(frame["type"], "agents.config.result");
    assert.equal((frame["agents"] as Array<{ pinned: boolean }>)[1]!["pinned"], false);
  });

  test("agents.fallback.set forwards the model and answers with the stored state", async () => {
    client.ws.send(JSON.stringify({ type: "agents.fallback.set", model: "strong-2" }));
    const frame = await nextFrame(client);
    assert.equal(frame["type"], "agents.config.result");
    assert.equal(frame["fallback"], "strong-2");
  });

  test("agents.fallback.set with an empty model removes the pin", async () => {
    client.ws.send(JSON.stringify({ type: "agents.fallback.set", model: "" }));
    const frame = await nextFrame(client);
    assert.equal(frame["type"], "agents.config.result");
    assert.equal(frame["fallback"], "");
  });

  test("agents.model.set carries the effort pin in the same pass", async () => {
    client.ws.send(JSON.stringify({ type: "agents.model.set", agent: "cron", model: "strong-2", effort: "medium" }));
    const frame = await nextFrame(client);
    assert.equal(frame["type"], "agents.config.result");
    assert.equal(frame["defaultModel"], "strong-2");
    assert.equal(frame["defaultEffort"], "medium");
  });

  test("agents.scope.set forwards mode and names and answers with the stored snapshot", async () => {
    client.ws.send(JSON.stringify({ type: "agents.scope.set", agent: "cron", field: "skills", mode: "list", names: ["code-review"] }));
    const frame = await nextFrame(client);
    assert.equal(frame["type"], "agents.config.result");
    assert.deepEqual((frame["agents"] as Array<Record<string, unknown>>)[1]?.["skills"], ["code-review"]);
  });

  test("agents.scope.set refuses an invalid mode", async () => {
    client.ws.send(JSON.stringify({ type: "agents.scope.set", agent: "cron", field: "skills", mode: "sometimes" }));
    const frame = await nextFrame(client);
    assert.equal(frame["type"], "error");
    assert.equal(frame["scope"], "agents");
  });

  test("agents.workspace.set forwards the workspace key", async () => {
    client.ws.send(JSON.stringify({ type: "agents.workspace.set", agent: "cron", workspace: "sofa" }));
    const frame = await nextFrame(client);
    assert.equal(frame["type"], "agents.config.result");
    assert.equal((frame["agents"] as Array<Record<string, unknown>>)[1]?.["workspace"], "sofa");
  });

  test("agents.iterations.set forwards the value", async () => {
    client.ws.send(JSON.stringify({ type: "agents.iterations.set", agent: "cron", value: 12 }));
    const frame = await nextFrame(client);
    assert.equal(frame["type"], "agents.config.result");
    assert.equal((frame["agents"] as Array<Record<string, unknown>>)[1]?.["maxIterations"], 12);
  });

  test("agents.contextcap.set forwards the value", async () => {
    client.ws.send(JSON.stringify({ type: "agents.contextcap.set", agent: "cron", value: 200_000 }));
    const frame = await nextFrame(client);
    assert.equal(frame["type"], "agents.config.result");
    assert.equal((frame["agents"] as Array<Record<string, unknown>>)[1]?.["contextCap"], 200_000);
  });

  test("agents.file.get answers the structured file of a file-defined agent", async () => {
    const storeB = new FakeSessionStore();
    const withFile = new MyClawAppAdapter(createConfig(), storeB as never);
    withFile.onAgentsController({
      get: () => SNAPSHOT,
      setModel: async () => SNAPSHOT,
      clearModel: async () => SNAPSHOT,
      setFallback: async () => SNAPSHOT,
      setScope: async () => SNAPSHOT,
      setWorkspace: async () => SNAPSHOT,
      setMaxIterations: async () => SNAPSHOT,
      setContextCap: async () => SNAPSHOT,
      fileGet: async (agent) => ({
        type: "agents.file.result",
        name: agent,
        source: "custom",
        path: "/tmp/agents/reviewer.md",
        editable: true,
        sha: "aaaabbbbcccc",
        description: "Reviews a diff",
        base: "research",
        skillsMode: "list",
        skills: ["code-review"],
        mcpMode: "absent",
        prompt: "You review code.",
        toolOptions: ["read", "grep"],
        unknownTools: [],
      }),
      fileSet: async () => {
        throw new Error("nope");
      },
      fileCreate: async () => {
        throw new Error("nope");
      },
      fileDelete: async () => {
        throw new Error("nope");
      },
    });
    await withFile.start();
    try {
      const c = await connectClient(withFile.port);
      c.ws.send(JSON.stringify({ type: "agents.file.get", agent: "reviewer" }));
      const frame = await nextFrame(c);
      assert.equal(frame["type"], "agents.file.result");
      assert.equal(frame["description"], "Reviews a diff");
      assert.equal(frame["editable"], true);
      assert.equal(frame["skillsMode"], "list");
      c.ws.close();
    } finally {
      await withFile.stop();
    }
  });

  test("agents.file.get refuses a reserved role without a file", async () => {
    client.ws.send(JSON.stringify({ type: "agents.file.get", agent: "orchestrator" }));
    const frame = await nextFrame(client);
    assert.equal(frame["type"], "error");
    assert.equal(frame["scope"], "agents");
    assert.match(frame["message"] as string, /not a file-defined agent/);
  });

  test("a throwing controller surfaces as a refused error", async () => {
    store = new FakeSessionStore();
    const failing = new MyClawAppAdapter(createConfig(), store as never);
    failing.onAgentsController({
      get: () => SNAPSHOT,
      setModel: async () => {
        throw new Error("unknown model: ghost");
      },
      clearModel: async () => {
        throw new Error("nope");
      },
      setFallback: async () => {
        throw new Error("nope");
      },
      setScope: async () => {
        throw new Error("nope");
      },
      setWorkspace: async () => {
        throw new Error("nope");
      },
      setMaxIterations: async () => {
        throw new Error("nope");
      },
      setContextCap: async () => {
        throw new Error("nope");
      },
      fileGet: async () => null,
      fileSet: async () => {
        throw new Error("nope");
      },
      fileCreate: async () => {
        throw new Error("nope");
      },
      fileDelete: async () => {
        throw new Error("nope");
      },
    });
    await failing.start();
    try {
      const c = await connectClient(failing.port);
      c.ws.send(JSON.stringify({ type: "agents.model.set", agent: "cron", model: "ghost" }));
      const frame = await nextFrame(c);
      assert.equal(frame["type"], "error");
      assert.equal(frame["scope"], "agents");
      c.ws.close();
    } finally {
      await failing.stop();
    }
  });
});

describe("tags frames", () => {
  let adapter: MyClawAppAdapter;
  let client: WsClient;
  let store: FakeSessionStore;
  const TAGS_RESULT = {
    type: "tags.result" as const,
    tags: [
      { name: "Default", model: "fast-1" },
      { name: "opus", model: "claude-opus-4-8", effort: "xhigh", contextCap: 50000 },
    ],
  };

  beforeEach(async () => {
    store = new FakeSessionStore();
    adapter = new MyClawAppAdapter(createConfig(), store as never);
    adapter.onTagsController({
      list: () => TAGS_RESULT,
      upsert: async (fields) => ({ type: "tags.result", tags: [...TAGS_RESULT.tags, { name: fields.name, model: fields.model }] }),
      delete: async (name) => ({ type: "tags.result", tags: TAGS_RESULT.tags.filter((t) => t.name !== name) }),
    });
    await adapter.start();
    client = await connectClient(adapter.port);
  });

  afterEach(async () => {
    client.ws.close();
    await adapter.stop();
  });

  test("tags.list answers with the fresh listing", async () => {
    client.ws.send(JSON.stringify({ type: "tags.list" }));
    const frame = await nextFrame(client);
    assert.equal(frame["type"], "tags.result");
    assert.equal((frame["tags"] as unknown[]).length, 2);
    assert.equal((frame["tags"] as Array<{ name: string }>)[1]?.["name"], "opus");
  });

  test("tags.upsert forwards name and model and answers with the listing", async () => {
    client.ws.send(JSON.stringify({ type: "tags.upsert", name: "sonnet", model: "claude-sonnet-4" }));
    const frame = await nextFrame(client);
    assert.equal(frame["type"], "tags.result");
    assert.ok((frame["tags"] as Array<{ name: string }>).some((t) => t.name === "sonnet"));
  });

  test("tags.upsert with a missing name is refused", async () => {
    client.ws.send(JSON.stringify({ type: "tags.upsert", model: "claude-opus-4-8" }));
    const frame = await nextFrame(client);
    assert.equal(frame["type"], "error");
    assert.equal(frame["scope"], "tags");
  });

  test("tags.delete forwards the name and answers with the listing", async () => {
    client.ws.send(JSON.stringify({ type: "tags.delete", name: "opus" }));
    const frame = await nextFrame(client);
    assert.equal(frame["type"], "tags.result");
    assert.ok(!(frame["tags"] as Array<{ name: string }>).some((t) => t.name === "opus"));
  });
});

describe("mcp frames", () => {
  let adapter: MyClawAppAdapter;
  let client: WsClient;
  let store: FakeSessionStore;
  const SERVERS: MyClawAppMcpEntry[] = [
    { name: "mailcow", transport: "stdio", state: "connected", toolCount: 2, lastAttemptAt: "2026-02-01T10:00:00.000Z" },
    { name: "weather", transport: "http", state: "failed", toolCount: 0, lastError: "spawn ENOENT", lastAttemptAt: "2026-02-01T10:00:01.000Z" },
    { name: "off", transport: "sse", state: "disabled", toolCount: 0 },
  ];

  beforeEach(async () => {
    store = new FakeSessionStore();
    adapter = new MyClawAppAdapter(createConfig(), store as never);
    adapter.onMcpController({
      list: () => SERVERS,
      add: async (spec) => [...SERVERS, { name: spec.name, transport: spec.transport, state: "disabled", toolCount: 0 }],
      remove: async (name) => SERVERS.filter((s) => s.name !== name),
      setEnabled: async (name, enabled) => SERVERS.map((s) => (s.name === name ? { ...s, enabled: enabled ? undefined : false, state: enabled ? "connected" : "disabled" } : s)),
    });
    await adapter.start();
    client = await connectClient(adapter.port);
  });

  afterEach(async () => {
    client.ws.close();
    await adapter.stop();
  });

  test("mcp.list answers with every declared server, failed and disabled included", async () => {
    client.ws.send(JSON.stringify({ type: "mcp.list" }));
    const frame = await nextFrame(client);
    assert.equal(frame["type"], "mcp.list.result");
    const servers = frame["servers"] as Array<Record<string, unknown>>;
    assert.deepEqual(servers.map((s) => s["name"]), ["mailcow", "weather", "off"]);
    assert.deepEqual(servers.map((s) => s["state"]), ["connected", "failed", "disabled"]);
    assert.equal(servers[1]?.["lastError"], "spawn ENOENT");
    assert.equal(servers[2]?.["lastAttemptAt"], undefined);
  });

  test("mcp.list shows the declared wiring minus the secrets (env/headers)", async () => {
    const withDeclared: MyClawAppMcpEntry[] = [
      { name: "mailcow", transport: "stdio", state: "connected", toolCount: 2, command: "mcp-mail", args: ["--port", "2525"], enabled: false },
    ];
    const rich = new MyClawAppAdapter(createConfig(), store as never);
    rich.onMcpController({
      list: () => withDeclared,
      add: async () => withDeclared,
      remove: async () => withDeclared,
      setEnabled: async () => withDeclared,
    });
    await rich.start();
    try {
      const c = await connectClient(rich.port);
      c.ws.send(JSON.stringify({ type: "mcp.list" }));
      const frame = await nextFrame(c);
      const entry = (frame["servers"] as Array<Record<string, unknown>>)[0]!;
      assert.equal(entry["command"], "mcp-mail");
      assert.equal(entry["enabled"], false);
      for (const secret of ["env", "headers"]) {
        assert.equal(secret in entry, false, `${secret} must never reach a device`);
      }
      c.ws.close();
    } finally {
      await rich.stop();
    }
  });

  test("mcp.list without a controller answers an error instead of hanging", async () => {
    const bare = new MyClawAppAdapter(createConfig(), store as never);
    await bare.start();
    try {
      const c = await connectClient(bare.port);
      c.ws.send(JSON.stringify({ type: "mcp.list" }));
      const frame = await nextFrame(c);
      assert.equal(frame["type"], "error");
      assert.equal(frame["scope"], "mcp");
      assert.match(frame["message"] as string, /MCP status unavailable/);
      c.ws.close();
    } finally {
      await bare.stop();
    }
  });

  test("mcp.add declares a server and answers with the fresh listing", async () => {
    client.ws.send(JSON.stringify({ type: "mcp.add", name: "gitlab", transport: "http", url: "http://mcp.local" }));
    const frame = await nextFrame(client);
    assert.equal(frame["type"], "mcp.list.result");
    const servers = frame["servers"] as Array<Record<string, unknown>>;
    assert.deepEqual(servers.map((s) => s["name"]), [...SERVERS.map((s) => s.name), "gitlab"]);
    assert.equal((servers.at(-1) as Record<string, unknown>)["transport"], "http");
  });

  test("mcp.remove drops the server and answers with the fresh listing", async () => {
    client.ws.send(JSON.stringify({ type: "mcp.remove", name: "weather" }));
    const frame = await nextFrame(client);
    assert.equal(frame["type"], "mcp.list.result");
    const servers = frame["servers"] as Array<Record<string, unknown>>;
    assert.deepEqual(servers.map((s) => s["name"]), ["mailcow", "off"]);
  });

  test("mcp.enable toggles the enabled key", async () => {
    client.ws.send(JSON.stringify({ type: "mcp.enable", name: "mailcow", enabled: false }));
    const frame = await nextFrame(client);
    assert.equal(frame["type"], "mcp.list.result");
    const mailcow = (frame["servers"] as Array<Record<string, unknown>>).find((s) => s["name"] === "mailcow");
    assert.equal(mailcow?.["enabled"], false);
    assert.equal(mailcow?.["state"], "disabled");
  });

  test("a throwing controller surfaces as a refused error", async () => {
    const failing = new MyClawAppAdapter(createConfig(), store as never);
    failing.onMcpController({
      list: () => {
        throw new Error("manager down");
      },
      add: async () => {
        throw new Error("manager down");
      },
      remove: async () => {
        throw new Error("manager down");
      },
      setEnabled: async () => {
        throw new Error("manager down");
      },
    });
    await failing.start();
    try {
      const c = await connectClient(failing.port);
      c.ws.send(JSON.stringify({ type: "mcp.list" }));
      const frame = await nextFrame(c);
      assert.equal(frame["type"], "error");
      assert.equal(frame["scope"], "mcp");
      c.ws.close();
    } finally {
      await failing.stop();
    }
  });
});

describe("tools frames", () => {
  let adapter: MyClawAppAdapter;
  let client: WsClient;
  let store: FakeSessionStore;
  const TOOLS: MyClawAppToolEntry[] = [
    { name: "read", description: "Read a file", source: "built-in", disabled: false },
    { name: "bash", description: "Run a command", source: "built-in", disabled: true },
    { name: "my_weather", description: "Forecast for a city", source: "plugin", disabled: false },
    { name: "mcp__mailcow__get_status", description: "Mail server status", source: "mcp", server: "mailcow", disabled: false },
    { name: "mcp__mailcow__send_mail", description: "Send a mail", source: "mcp", server: "mailcow", disabled: false },
  ];

  beforeEach(async () => {
    store = new FakeSessionStore();
    adapter = new MyClawAppAdapter(createConfig(), store as never);
    adapter.onToolsController({
      list: () => ({ tools: TOOLS, missing: [] }),
      toggle: async (name, disabled) => ({
        tools: TOOLS.map((t) => (t.name === name ? { ...t, disabled } : t)),
        missing: [],
      }),
    });
    await adapter.start();
    client = await connectClient(adapter.port);
  });

  afterEach(async () => {
    client.ws.close();
    await adapter.stop();
  });

  test("tools.list answers the whole catalog, sources and server names included", async () => {
    client.ws.send(JSON.stringify({ type: "tools.list" }));
    const frame = await nextFrame(client);
    assert.equal(frame["type"], "tools.list.result");
    const tools = frame["tools"] as Array<Record<string, unknown>>;
    assert.equal(tools.length, TOOLS.length);
    assert.deepEqual(tools[0], { name: "read", description: "Read a file", source: "built-in", disabled: false });
    assert.deepEqual(tools[1], { name: "bash", description: "Run a command", source: "built-in", disabled: true });
    assert.deepEqual(tools[2], { name: "my_weather", description: "Forecast for a city", source: "plugin", disabled: false });
    assert.equal(tools[3]?.["server"], "mailcow");
  });

  test("tools.toggle forwards name and disabled and answers with the fresh catalog", async () => {
    client.ws.send(JSON.stringify({ type: "tools.toggle", name: "bash", disabled: false }));
    const frame = await nextFrame(client);
    assert.equal(frame["type"], "tools.list.result");
    const bash = (frame["tools"] as Array<Record<string, unknown>>).find((t) => t["name"] === "bash");
    assert.equal(bash?.["disabled"], false);
    assert.deepEqual(frame["missing"], []);
  });

  test("tools.list without a controller answers an error instead of hanging", async () => {
    const bare = new MyClawAppAdapter(createConfig(), store as never);
    await bare.start();
    try {
      const c = await connectClient(bare.port);
      c.ws.send(JSON.stringify({ type: "tools.list" }));
      const frame = await nextFrame(c);
      assert.equal(frame["type"], "error");
      assert.equal(frame["scope"], "tools");
      assert.match(frame["message"] as string, /tool catalog unavailable/);
      c.ws.close();
    } finally {
      await bare.stop();
    }
  });

  test("a throwing controller surfaces as a refused error", async () => {
    const failing = new MyClawAppAdapter(createConfig(), store as never);
    failing.onToolsController({
      list: () => {
        throw new Error("registry down");
      },
      toggle: async () => {
        throw new Error("registry down");
      },
    });
    await failing.start();
    try {
      const c = await connectClient(failing.port);
      c.ws.send(JSON.stringify({ type: "tools.list" }));
      const frame = await nextFrame(c);
      assert.equal(frame["type"], "error");
      assert.equal(frame["scope"], "tools");
      c.ws.close();
    } finally {
      await failing.stop();
    }
  });
});

describe("instructions frames", () => {
  let adapter: MyClawAppAdapter;
  let client: WsClient;
  let store: FakeSessionStore;
  let written: Array<{ workspace: string; file: string; content: string; sha?: string }>;

  beforeEach(async () => {
    store = new FakeSessionStore();
    written = [];
    adapter = new MyClawAppAdapter(createConfig(), store as never);
    adapter.onInstructionsController({
      list: async () => ({
        entries: [
          { workspace: "default", file: "AGENTS.md", origin: "own", from: "default", bytes: 12, sha: "abc123abc123", inherit: "default", off: false, empty: false },
          { workspace: "sofa", file: "AGENTS.md", origin: "inherited", from: "default", bytes: 12, sha: "abc123abc123", inherit: "default", off: false, empty: false },
        ],
        nested: [{ workspace: "default", path: "svc/AGENTS.md", bytes: 40 }],
        files: ["CORE.md", "SOUL.md", "AGENTS.md", "USER.md"],
        maxBytes: 262144,
      }),
      read: async ({ workspace, file, nested }) => {
        if (nested) {
          return { workspace, file: nested, content: "nested body", origin: "nested", from: workspace, sha: "n1", editable: true };
        }
        if (file !== "AGENTS.md") return null;
        return { workspace, file, content: "body", origin: "own", from: workspace, sha: "abc123abc123", editable: true };
      },
      write: async ({ workspace, file, content, sha }) => {
        written.push({ workspace, file: file ?? "", content, ...(sha ? { sha } : {}) });
        if (sha === "stale") return { ok: false, sha: "", conflict: true, error: "changed on the server since it was opened" };
        return { ok: true, sha: "newsha", conflict: false };
      },
      setPolicy: async (workspace, file, inherit, off) => ({
        entries: [
          { workspace, file, origin: "own", from: workspace, bytes: 12, sha: "abc123abc123", inherit: inherit ?? "default", off: off ?? false, empty: off ?? false },
        ],
        nested: [],
        files: ["CORE.md", "SOUL.md", "AGENTS.md", "USER.md"],
        maxBytes: 262144,
      }),
    });
    await adapter.start();
    client = await connectClient(adapter.port);
  });

  afterEach(async () => {
    client.ws.close();
    await adapter.stop();
  });

  test("instructions.list carries the entries, the nested files and the server's own limits", async () => {
    client.ws.send(JSON.stringify({ type: "instructions.list" }));
    const frame = await nextFrame(client);
    assert.equal(frame["type"], "instructions.list.result");
    assert.equal((frame["entries"] as unknown[]).length, 2);
    assert.equal((frame["nested"] as unknown[]).length, 1);
    // The app must not hardcode the list the server enforces.
    assert.deepEqual(frame["files"], ["CORE.md", "SOUL.md", "AGENTS.md", "USER.md"]);
    assert.equal(frame["maxBytes"], 262144);
  });

  test("instructions.get answers with the content and whether it can be written back", async () => {
    client.ws.send(JSON.stringify({ type: "instructions.get", workspace: "default", file: "AGENTS.md" }));
    const frame = await nextFrame(client);
    assert.equal(frame["type"], "instructions.file");
    assert.equal(frame["content"], "body");
    assert.equal(frame["editable"], true);
    assert.equal(frame["sha"], "abc123abc123");
  });

  test("a nested AGENTS.md comes back editable, named as the nested file it is", async () => {
    client.ws.send(JSON.stringify({ type: "instructions.get", workspace: "default", nested: "svc/AGENTS.md" }));
    const frame = await nextFrame(client);
    assert.equal(frame["origin"], "nested");
    assert.equal(frame["file"], "svc/AGENTS.md");
    assert.equal(frame["editable"], true);
  });

  test("a nested write answers on the nested path, not on the empty file field", async () => {
    client.ws.send(
      JSON.stringify({ type: "instructions.set", workspace: "default", file: "", nested: "svc/AGENTS.md", content: "new", sha: "n1" }),
    );
    const frame = await nextFrame(client);
    assert.equal(frame["type"], "instructions.saved");
    assert.equal(frame["file"], "svc/AGENTS.md");
    assert.equal(frame["ok"], true);
  });

  test("an unknown file is refused with the instructions scope", async () => {
    client.ws.send(JSON.stringify({ type: "instructions.get", workspace: "default", file: "MEMORY.md" }));
    const frame = await nextFrame(client);
    assert.equal(frame["type"], "error");
    assert.equal(frame["scope"], "instructions");
  });

  test("instructions.set forwards the sha and answers with the stored one", async () => {
    client.ws.send(JSON.stringify({ type: "instructions.set", workspace: "sofa", file: "AGENTS.md", content: "new", sha: "abc123abc123" }));
    const frame = await nextFrame(client);
    assert.equal(frame["type"], "instructions.saved");
    assert.equal(frame["ok"], true);
    assert.equal(frame["sha"], "newsha");
    assert.equal(frame["conflict"], false);
    assert.deepEqual(written, [{ workspace: "sofa", file: "AGENTS.md", content: "new", sha: "abc123abc123" }]);
  });

  test("a create carries no sha at all, so the server can refuse an existing file", async () => {
    client.ws.send(JSON.stringify({ type: "instructions.set", workspace: "sofa", file: "AGENTS.md", content: "new" }));
    await nextFrame(client);
    assert.equal(written[0]?.sha, undefined);
  });

  test("a conflict answers on its own frame, not through the error scope", async () => {
    // The editor has to tell "reload first" apart from "the server is broken".
    client.ws.send(JSON.stringify({ type: "instructions.set", workspace: "sofa", file: "AGENTS.md", content: "new", sha: "stale" }));
    const frame = await nextFrame(client);
    assert.equal(frame["type"], "instructions.saved");
    assert.equal(frame["ok"], false);
    assert.equal(frame["conflict"], true);
    assert.match(frame["error"] as string, /changed on the server/);
  });

  test("instructions.set without content is refused instead of writing an empty file", async () => {
    client.ws.send(JSON.stringify({ type: "instructions.set", workspace: "sofa", file: "AGENTS.md" }));
    const frame = await nextFrame(client);
    assert.equal(frame["type"], "error");
    assert.equal(frame["scope"], "instructions");
    assert.equal(written.length, 0);
  });
  test("instructions.layer.set forwards the policy and answers with the fresh listing", async () => {
    client.ws.send(JSON.stringify({ type: "instructions.layer.set", workspace: "sofa", file: "SOUL.md", inherit: "lab", off: true }));
    const frame = await nextFrame(client);
    assert.equal(frame["type"], "instructions.list.result");
    const entry = (frame["entries"] as Array<Record<string, unknown>>)[0]!;
    assert.equal(entry["workspace"], "sofa");
    assert.equal(entry["inherit"], "lab");
    assert.equal(entry["off"], true);
  });
  test("instructions.layer.set without a file is refused", async () => {
    client.ws.send(JSON.stringify({ type: "instructions.layer.set", workspace: "sofa" }));
    const frame = await nextFrame(client);
    assert.equal(frame["type"], "error");
    assert.equal(frame["scope"], "instructions");
  });

  test("without a controller every instructions frame is refused, not dropped", async () => {
    const bare = new MyClawAppAdapter(createConfig(), store as never);
    await bare.start();
    try {
      const c = await connectClient(bare.port);
      for (const frame of [
        { type: "instructions.list" },
        { type: "instructions.get", workspace: "default", file: "AGENTS.md" },
        { type: "instructions.set", workspace: "default", file: "AGENTS.md", content: "x" },
      ]) {
        c.ws.send(JSON.stringify(frame));
        const answer = await nextFrame(c);
        assert.equal(answer["type"], "error");
        assert.equal(answer["scope"], "instructions");
      }
      c.ws.close();
    } finally {
      await bare.stop();
    }
  });
});

describe("command frames", () => {
  let adapter: MyClawAppAdapter;
  let client: WsClient;
  let store: FakeSessionStore;
  let handled: Array<{ command: string; args: string }>;

  beforeEach(async () => {
    store = new FakeSessionStore();
    handled = [];
    adapter = new MyClawAppAdapter(createConfig(), store as never);
    adapter.onMessage(async () => {
      throw new Error("a command must never reach the agent");
    });
    adapter.onCommandHandler(async (_owner, _threadId, command, args) => {
      handled.push({ command, args });
      return `${command} done`;
    });
    let stopped: string | null = null;
    adapter.onStop((sessionId) => {
      stopped = sessionId;
      return stopped !== null;
    });
    await adapter.start();
    client = await connectClient(adapter.port);
  });

  afterEach(async () => {
    client.ws.close();
    await adapter.stop();
  });

  test("a catalog slash command runs on the server and replies with chat.command.result", async () => {
    client.ws.send(JSON.stringify({ type: "chat.send", id: "c1", text: "/status --full", threadId: "t1" }));
    const frame = await nextFrame(client);
    assert.equal(frame["type"], "chat.command.result");
    assert.equal(frame["text"], "status done");
    assert.equal(frame["replyToId"], "c1");
    assert.deepEqual(handled, [{ command: "status", args: "--full" }]);
  });

  test("a command and its answer are journaled, so a reopened thread still shows them", async () => {
    client.ws.send(JSON.stringify({ type: "chat.send", id: "j1", text: "/compact", threadId: "t1" }));
    await nextFrame(client);
    assert.deepEqual(store.journal, [{ threadId: "t1", input: "/compact", output: "compact done" }]);
  });

  test("the journal never keeps a credential", async () => {
    client.ws.send(JSON.stringify({ type: "chat.send", id: "j2", text: "/claude set-token sk-live-secret", threadId: "t1" }));
    await nextFrame(client);
    assert.deepEqual(store.journal.map((e) => e.input), ["/claude set-token [redacted]"]);
  });

  test("a failed command is journaled too: the owner saw that bubble", async () => {
    adapter.onCommandHandler(async () => {
      throw new Error("boom");
    });
    client.ws.send(JSON.stringify({ type: "chat.send", id: "j3", text: "/compact", threadId: "t1" }));
    await nextFrame(client);
    assert.deepEqual(store.journal.map((e) => e.output), ["error: boom"]);
  });

  test("/new is not journaled: it ends the history a journal belongs to", async () => {
    client.ws.send(JSON.stringify({ type: "chat.send", id: "j4", text: "/new", threadId: "t1" }));
    await nextFrame(client);
    assert.deepEqual(store.journal, []);
  });

  test("a fast command answers without ever showing a pending bubble", async () => {
    client.ws.send(JSON.stringify({ type: "chat.send", id: "c2", text: "/status", threadId: "t1" }));
    const frame = await nextFrame(client);
    assert.equal(frame["type"], "chat.command.result", "the result must come first, unannounced");
  });

  test("a slow command says it is running, and its result replaces that bubble", async () => {
    let finish!: (text: string) => void;
    const slow = new Promise<string>((resolve) => {
      finish = resolve;
    });
    adapter.onCommandHandler(async () => slow);

    client.ws.send(JSON.stringify({ type: "chat.send", id: "c3", text: "/compact", threadId: "t1" }));
    const pending = await nextFrame(client);
    assert.equal(pending["type"], "chat.command.pending");
    assert.equal(pending["replyToId"], "c3", "the app keys the placeholder on the send it answers");
    assert.equal(pending["text"], "Running /compact...");

    finish("Context compacted (SDK session summarized).");
    const result = await nextFrame(client);
    assert.equal(result["type"], "chat.command.result");
    assert.equal(result["replyToId"], "c3");
    assert.equal(result["text"], "Context compacted (SDK session summarized).");
  });

  const STATUS_PAYLOAD = {
    session: {
      id: "my-claw-app/dm/test-device/t9",
      platform: "my-claw-app",
      chatType: "dm",
      createdAt: "2026-08-08T10:00:00.000Z",
      lastActiveAt: "2026-08-08T11:00:00.000Z",
      messages: 2,
    },
    model: {
      current: "claude-opus-5",
      selfHosted: false,
      contextLimit: 512_000,
      contextNotes: ["declared", "capped from 1,000,000"],
    },
    context: {
      measured: { tokens: 12_345, pctOfLimit: 2.4 },
      estimated: 60_000,
      occupied: 70_000,
      autoCompactOn: true,
      autoCompactThresholdPct: 80,
      autoCompactThresholdTokens: 409_600,
    },
    conversation: { calls: 1, promptTokens: 12_345, cacheReadTokens: 0, completionTokens: 10 },
    analytics: {
      calls: 4,
      errors: 0,
      durationMs: 4000,
      billedUsd: 2.0,
      referenceUsd: 5.0,
      unpriced: 0,
      rows: [
        {
          model: "claude-opus-5",
          calls: 4,
          promptTokens: 1000,
          cacheReadTokens: 0,
          completionTokens: 100,
          costUsd: 2.0,
          costBilled: true,
          costApproximate: false,
        },
      ],
    },
    delegated: null,
    runtime: { activeRun: "none", verbose: true, approvedTools: ["bash"], sdkSessionId: "sdk-1" },
  };

  test("a /status reply carries the structured payload for the fullscreen page", async () => {
    const agent = new MyClawAppAdapter(createConfig(), store as never);
    agent.onCommandHandler(async () => ({ text: "status text", status: STATUS_PAYLOAD }));
    await agent.start();
    const client2 = await connectClient(agent.port);
    client2.ws.send(JSON.stringify({ type: "chat.send", id: "c9", text: "/status", threadId: "t9" }));
    const frame = await nextFrame(client2);
    assert.equal(frame["type"], "chat.command.result");
    assert.equal(frame["text"], "status text");
    assert.deepEqual(frame["status"], STATUS_PAYLOAD);
    assert.deepEqual(store.journal, [], "a report drawn as a page was never a bubble to replay");
    client2.ws.close();
    await agent.stop();
  });

  test("status.get answers the report the menu opened", async () => {
    const agent = new MyClawAppAdapter(createConfig(), store as never);
    agent.onCommandHandler(async (_owner, threadId) => ({ text: `status of ${threadId}`, status: STATUS_PAYLOAD }));
    await agent.start();
    const client2 = await connectClient(agent.port);
    client2.ws.send(JSON.stringify({ type: "status.get", threadId: "t9" }));
    const frame = await nextFrame(client2);
    assert.equal(frame["type"], "status.result");
    assert.equal(frame["threadId"], "t9");
    assert.equal(frame["text"], "status of t9");
    assert.deepEqual(frame["status"], STATUS_PAYLOAD);
    client2.ws.close();
    await agent.stop();
  });

  test("status.get for a thread id that cannot land in a file path is refused", async () => {
    client.ws.send(JSON.stringify({ type: "status.get", threadId: "bad/id!" }));
    const frame = await nextFrame(client);
    assert.equal(frame["type"], "error");
    assert.equal(frame["scope"], "status");
  });

  test("session.instructions.get answers the report of the conversation that asked", async () => {
    const agent = new MyClawAppAdapter(createConfig(), store as never);
    const asked: string[] = [];
    agent.onSessionInstructions(async (sessionId) => {
      asked.push(sessionId);
      return {
        agent: "orchestrator",
        workspace: "default",
        workspaceDir: "/ws",
        model: "m",
        backend: "openai",
        platform: "my-claw-app",
        totalBytes: 3,
        layers: [{ id: "CORE", label: "Core directives", bytes: 3, text: "abc" }],
        nested: [],
        notes: [],
      };
    });
    await agent.start();
    const client2 = await connectClient(agent.port);
    client2.ws.send(JSON.stringify({ type: "session.instructions.get", threadId: "t9" }));
    const frame = await nextFrame(client2);
    assert.equal(frame["type"], "session.instructions.result");
    assert.equal(frame["threadId"], "t9");
    assert.equal((frame["instructions"] as Record<string, unknown>)["totalBytes"], 3);
    // The provider is handed a session id, never a thread id: the owner mapping stays server side.
    assert.ok(asked[0]?.includes("t9"));
    client2.ws.close();
    await agent.stop();
  });

  test("session.instructions.get without a provider is refused on the instructions scope", async () => {
    const agent = new MyClawAppAdapter(createConfig(), store as never);
    await agent.start();
    const client2 = await connectClient(agent.port);
    client2.ws.send(JSON.stringify({ type: "session.instructions.get", threadId: "t9" }));
    const frame = await nextFrame(client2);
    assert.equal(frame["type"], "error");
    assert.equal(frame["scope"], "instructions");
    client2.ws.close();
    await agent.stop();
  });

  test("status.get without a command handler is refused where the page asked", async () => {
    const agent = new MyClawAppAdapter(createConfig(), store as never);
    await agent.start();
    const client2 = await connectClient(agent.port);
    client2.ws.send(JSON.stringify({ type: "status.get", threadId: "t9" }));
    const frame = await nextFrame(client2);
    assert.equal(frame["type"], "error");
    assert.equal(frame["scope"], "status");
    client2.ws.close();
    await agent.stop();
  });

  test("a command removed from the catalog is no longer intercepted", async () => {
    client.ws.send(JSON.stringify({ type: "chat.send", id: "c7", text: "/clear", threadId: "t11" }));
    // The adapter must not answer: /clear no longer exists as a channel command. Give any
    // stray reply a beat to arrive, then check the command handler was never consulted.
    await new Promise((r) => setTimeout(r, 150));
    assert.deepEqual(handled, []);
    assert.equal(client.frames.length, 0);
  });

  test("an unknown slash command still reaches the agent", async () => {
    let gotMessage = false;
    const agent = new MyClawAppAdapter(createConfig(), store as never);
    agent.onMessage(async () => {
      gotMessage = true;
    });
    await agent.start();
    const client2 = await connectClient(agent.port);
    client2.ws.send(JSON.stringify({ type: "chat.send", id: "c2", text: "/imaginary thing" }));
    await waitUntil(() => gotMessage);
    client2.ws.close();
    await agent.stop();
  });

  test("chat.stop resolves the session and answers like /stop", async () => {
    client.ws.send(JSON.stringify({ type: "chat.stop", threadId: "t9" }));
    const frame = await nextFrame(client);
    assert.equal(frame["type"], "chat.command.result");
  });

  test("session.clear is gone: emptying a conversation is not offered anymore", async () => {
    client.ws.send(JSON.stringify({ type: "session.clear", threadId: "t5" }));
    // Unknown frames are ignored, so prove it by getting an answer to the next one instead.
    client.ws.send(JSON.stringify({ type: "session.list" }));
    const frame = await nextFrame(client);
    assert.equal(frame["type"], "session.list.result");
  });

  test("a typed /new also empties the device's screen copy", async () => {
    client.ws.send(JSON.stringify({ type: "chat.send", id: "c4", text: "/new", threadId: "t8" }));
    const cleared = await nextFrame(client);
    assert.equal(cleared["type"], "chat.cleared");
    assert.equal(cleared["threadId"], "t8");
    const reply = await nextFrame(client);
    assert.equal(reply["type"], "chat.command.result");
  });

  test("/model with an agent name keeps the whole argument", async () => {
    client.ws.send(JSON.stringify({ type: "chat.send", id: "c5", text: "/model general", threadId: "t9" }));
    const reply = await nextFrame(client);
    assert.equal(reply["type"], "chat.command.result");
    assert.equal(reply["replyToId"], "c5");
    assert.deepEqual(handled, [{ command: "model", args: "general" }]);
  });

  test("skills.list returns the catalog from the injected controller", async () => {
    adapter.onSkillsController({
      list: () => ({
        skills: [
          { name: "voice", description: "Voice mode plumbing", version: "1.0.0", source: "built-in", path: "/s/.builtin/voice/SKILL.md" },
          { name: "forgejo", description: "Forgejo operations", source: "custom", path: "/s/forgejo/SKILL.md" },
          { name: "mailcow", description: "Mail server chores", source: "workspace", path: "/w/skills/mailcow/SKILL.md" },
        ],
      }),
      read: async () => null,
      workspaces: () => [],
      transfer: async () => ({ skills: [] }),
    });

    client.ws.send(JSON.stringify({ type: "skills.list" }));
    const frame = (await nextFrame(client)) as { type: string; skills: Array<{ name: string; source: string; version?: string }> };
    assert.equal(frame.type, "skills.list.result");
    assert.equal(frame.skills.length, 3);
    assert.deepEqual(frame.skills.map((s) => s.source), ["built-in", "custom", "workspace"]);
    assert.equal(frame.skills[0]?.version, "1.0.0");
  });

  test("skills.list without a controller answers an error instead of hanging", async () => {
    client.ws.send(JSON.stringify({ type: "skills.list" }));
    const frame = (await nextFrame(client)) as { type: string; scope: string; message: string };
    assert.equal(frame.type, "error");
    assert.equal(frame.scope, "skills");
    assert.match(frame.message, /skill catalog unavailable/);
  });

  test("the skills endpoint serves a raw SKILL.md to a paired device", async () => {
    const seen: { source?: string; name?: string } = {};
    adapter.onSkillsController({
      list: () => ({ skills: [] }),
      read: async (source, name) => {
        seen.source = source;
        seen.name = name;
        return name === "nope" ? null : "# Skill\n\nbody\n";
      },
      workspaces: () => [
        { key: "default", path: "/w", default: true },
        { key: "sofa", path: "/s", default: false },
      ],
      transfer: async () => ({ skills: [] }),
    });

    const ok = await fetch(`http://127.0.0.1:${adapter.port}/skills?device=${DEVICE_ID}&token=${TOKEN}&source=custom&name=forgejo`);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("content-type"), "text/markdown; charset=utf-8");
    assert.equal(await ok.text(), "# Skill\n\nbody\n");
    assert.deepEqual(seen, { source: "custom", name: "forgejo" });

    const unauthorized = await fetch(`http://127.0.0.1:${adapter.port}/skills?source=custom&name=forgejo`);
    assert.equal(unauthorized.status, 401);

    const badSource = await fetch(`http://127.0.0.1:${adapter.port}/skills?device=${DEVICE_ID}&token=${TOKEN}&source=../&name=x`);
    assert.equal(badSource.status, 400);

    const badName = await fetch(`http://127.0.0.1:${adapter.port}/skills?device=${DEVICE_ID}&token=${TOKEN}&source=custom&name=..%2F..%2Fetc%2Fpasswd`);
    assert.equal(badName.status, 400);
    assert.equal(seen.name, "forgejo", "the crafted name must never reach the controller");

    const missing = await fetch(`http://127.0.0.1:${adapter.port}/skills?device=${DEVICE_ID}&token=${TOKEN}&source=custom&name=nope`);
    assert.equal(missing.status, 404);
  });

  test("skills.copy hands the transfer to the controller and answers with the fresh catalog", async () => {
    const seen: unknown[] = [];
    adapter.onSkillsController({
      list: () => ({ skills: [] }),
      read: async () => null,
      workspaces: () => [],
      transfer: async (input) => {
        seen.push(input);
        return { skills: [{ name: "deploy", description: "Deploy", source: "custom", path: "/s/deploy/SKILL.md" }] };
      },
    });

    client.ws.send(
      JSON.stringify({
        type: "skills.copy",
        source: "workspace",
        name: "deploy",
        workspace: "sofa",
        target: { source: "custom" },
        overwrite: true,
      }),
    );
    const frame = (await nextFrame(client)) as { type: string; skills: Array<{ name: string }> };
    assert.equal(frame.type, "skills.list.result");
    assert.deepEqual(frame.skills.map((s) => s.name), ["deploy"]);
    assert.deepEqual(seen, [
      { mode: "copy", source: "workspace", name: "deploy", workspace: "sofa", target: { source: "custom" }, overwrite: true },
    ]);
  });

  test("skills.move names the mode the controller receives", async () => {
    const seen: Array<{ mode: string }> = [];
    adapter.onSkillsController({
      list: () => ({ skills: [] }),
      read: async () => null,
      workspaces: () => [],
      transfer: async (input) => {
        seen.push(input);
        return { skills: [] };
      },
    });

    client.ws.send(
      JSON.stringify({ type: "skills.move", source: "custom", name: "deploy", target: { source: "workspace", workspace: "sofa" } }),
    );
    await nextFrame(client);
    assert.equal(seen[0]?.mode, "move");
  });

  test("a transfer into built-in, or with a crafted name, never reaches the controller", async () => {
    let called = 0;
    adapter.onSkillsController({
      list: () => ({ skills: [] }),
      read: async () => null,
      workspaces: () => [],
      transfer: async () => {
        called += 1;
        return { skills: [] };
      },
    });

    const refusals = [
      { type: "skills.copy", source: "custom", name: "deploy", target: { source: "built-in" } },
      { type: "skills.copy", source: "custom", name: "../../etc/passwd", target: { source: "workspace" } },
      { type: "skills.copy", source: "custom", name: "deploy", target: { source: "workspace", workspace: "../x" } },
      { type: "skills.copy", source: "ghost", name: "deploy", target: { source: "custom" } },
    ];
    for (const frame of refusals) {
      client.ws.send(JSON.stringify(frame));
      const answer = (await nextFrame(client)) as { type: string; scope: string };
      assert.equal(answer.type, "error", `${JSON.stringify(frame)} must be refused`);
      assert.equal(answer.scope, "skills");
    }
    assert.equal(called, 0, "the filesystem must never be reached for a refused transfer");
  });

  test("workspaces.list returns the default and the named workspaces", async () => {
    adapter.onWorkspacesController({
      list: () => [
        { key: "default", path: "/w", default: true },
        { key: "sofa", path: "/s", default: false },
      ],
      add: async (key, path) => [
        { key: "default", path: "/w", default: true },
        { key: key, path, default: false },
      ],
      remove: async (key) => [{ key: "default", path: "/w", default: true }],
      rename: async (from, to) => [
        { key: "default", path: "/w", default: true },
        { key: to, path: "/s", default: false },
      ],
      setPath: async (key, path) => [
        { key: "default", path: "/w", default: true },
        { key, path, default: false },
      ],
    });

    client.ws.send(JSON.stringify({ type: "workspaces.list" }));
    const frame = (await nextFrame(client)) as { type: string; workspaces: Array<{ key: string; default?: boolean }> };
    assert.equal(frame.type, "workspaces.list.result");
    assert.equal(frame.workspaces.length, 2);
    assert.deepEqual(frame.workspaces.map((w) => w.key), ["default", "sofa"]);
    assert.equal(frame.workspaces[0]?.default, true);
  });

  test("workspaces.add/remove/rename/path.set answer with the fresh listing", async () => {
    adapter.onWorkspacesController({
      list: () => [],
      add: async (key, path) => [{ key, path, default: false }],
      remove: async (key) => [],
      rename: async (from, to) => [{ key: to, path: "/s", default: false }],
      setPath: async (key, path) => [{ key, path, default: false }],
    });

    client.ws.send(JSON.stringify({ type: "workspaces.add", key: "sofa", path: "/srv/sofa" }));
    let frame = await nextFrame(client);
    assert.equal(frame["type"], "workspaces.list.result");
    assert.deepEqual((frame["workspaces"] as Array<Record<string, unknown>>).map((w) => w["key"]), ["sofa"]);

    client.ws.send(JSON.stringify({ type: "workspaces.remove", key: "sofa" }));
    frame = await nextFrame(client);
    assert.deepEqual(frame["workspaces"], []);

    client.ws.send(JSON.stringify({ type: "workspaces.rename", from: "sofa", to: "couch" }));
    frame = await nextFrame(client);
    assert.deepEqual((frame["workspaces"] as Array<Record<string, unknown>>).map((w) => w["key"]), ["couch"]);

    client.ws.send(JSON.stringify({ type: "workspaces.path.set", key: "couch", path: "/srv/couch" }));
    frame = await nextFrame(client);
    assert.equal((frame["workspaces"] as Array<Record<string, unknown>>)[0]?.["path"], "/srv/couch");
  });

  test("workspaces.add without a controller answers an error instead of hanging", async () => {
    const bare = new MyClawAppAdapter(createConfig(), store as never);
    await bare.start();
    try {
      const c = await connectClient(bare.port);
      c.ws.send(JSON.stringify({ type: "workspaces.add", key: "sofa", path: "/srv/sofa" }));
      const frame = await nextFrame(c);
      assert.equal(frame["type"], "error");
      assert.equal(frame["scope"], "workspaces");
      c.ws.close();
    } finally {
      await bare.stop();
    }
  });

  test("GET /health answers the maintenance gate to a paired device", async () => {
    const res = await fetch(`http://127.0.0.1:${adapter.port}/health?device=${DEVICE_ID}&token=${TOKEN}`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { activeRun: boolean };
    assert.equal(body.activeRun, false);
  });

  test("GET /health refuses unpaired devices", async () => {
    const res = await fetch(`http://127.0.0.1:${adapter.port}/health?device=unknown-device&token=${TOKEN}`);
    assert.equal(res.status, 401);
  });

  test("GET /health reports an in-flight run", async () => {
    const handle = runRegistry.startRoot("health-test-session");
    try {
      const res = await fetch(`http://127.0.0.1:${adapter.port}/health?device=${DEVICE_ID}&token=${TOKEN}`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { activeRun: boolean };
      assert.equal(body.activeRun, true);
    } finally {
      handle.end();
    }
  });
});

describe("config frames", () => {
  let adapter: MyClawAppAdapter;
  let client: WsClient;
  let store: FakeSessionStore;
  const CONFIG_TEXT = '{\n  "llm": { "defaultModel": "fast-1" }\n}';
  const SHA = "cafebabe12345678";

  beforeEach(async () => {
    store = new FakeSessionStore();
    adapter = new MyClawAppAdapter(createConfig(), store as never);
    adapter.onConfigController({
      get: async () => ({ content: CONFIG_TEXT, sha: SHA, maxBytes: 1024 }),
      set: async (sha, content) => ({
        ok: true,
        sha: SHA,
        conflict: false,
        changed: ["llm"],
        rebootRequired: [],
        ...(content.includes("brocken") ? { ok: false, error: "Invalid config: llm must be an object" } : {}),
      }),
    });
    await adapter.start();
    client = await connectClient(adapter.port);
  });

  afterEach(async () => {
    client.ws.close();
    await adapter.stop();
  });

  test("config.get answers the raw text and the sha a write must echo", async () => {
    client.ws.send(JSON.stringify({ type: "config.get" }));
    const frame = await nextFrame(client);
    assert.equal(frame["type"], "config.result");
    assert.equal(frame["content"], CONFIG_TEXT);
    assert.equal(frame["sha"], SHA);
  });

  test("config.set forwards the round-trip and reports what the reload applied", async () => {
    client.ws.send(JSON.stringify({ type: "config.set", sha: SHA, content: CONFIG_TEXT }));
    const frame = await nextFrame(client);
    assert.equal(frame["type"], "config.saved");
    assert.equal(frame["ok"], true);
    assert.deepEqual(frame["changed"], ["llm"]);
    assert.deepEqual(frame["rebootRequired"], []);
  });

  test("config.set surfaces a controller refusal as a config-scoped error", async () => {
    client.ws.send(JSON.stringify({ type: "config.set", sha: SHA, content: "brocken json" }));
    const frame = await nextFrame(client);
    assert.equal(frame["type"], "config.saved");
    assert.equal(frame["ok"], false);
    assert.match(frame["error"] as string, /Invalid config/);
  });

  test("config.get without a controller answers an error instead of hanging", async () => {
    const bare = new MyClawAppAdapter(createConfig(), store as never);
    await bare.start();
    try {
      const c = await connectClient(bare.port);
      c.ws.send(JSON.stringify({ type: "config.get" }));
      const frame = await nextFrame(c);
      assert.equal(frame["type"], "error");
      assert.equal(frame["scope"], "config");
      c.ws.close();
    } finally {
      await bare.stop();
    }
  });
});

describe("scheduled jobs (jobs.*)", () => {
  let adapter: MyClawAppAdapter;
  let client: WsClient;
  let store: FakeSessionStore;
  let jobs: import("../src/cron/types.ts").CronJob[];

  // Mirrors the controller wired in src/index.ts: real store semantics (schedule parsing, scope
  // persistence) with the unknown-flag projection the app paints red.
  const wireJobs = (): MyClawAppJobEntry[] => {
    const modelIds = new Set(["gpt-5.1", "fast-1"]);
    const workspaceKeys = new Set(["sofa"]);
    const skillNames = new Set(["code-review"]);
    const mcpNames = new Set(["mailcow"]);
    const toolNames = new Set(["bash", "web_search"]);
    return jobs.map((job): MyClawAppJobEntry => {
      const skillsMode: "inherit" | "all" | "list" = job.skills === undefined ? "inherit" : job.skills.includes("*") ? "all" : "list";
      const mcpMode: "inherit" | "all" | "list" = job.mcp === undefined ? "inherit" : job.mcp.includes("*") ? "all" : "list";
      const toolsMode: "inherit" | "all" | "list" = job.tools === undefined ? "inherit" : job.tools.includes("*") ? "all" : "list";
      return {
        id: job.id,
        name: job.name,
        prompt: job.prompt,
        schedule: job.schedule,
        enabled: job.enabled,
        silent: job.silent === true,
        state: job.state,
        repeat: job.repeat,
        completedRuns: job.completedRuns,
        deliver: job.deliver === "local" || job.deliver === "origin" ? job.deliver : `${job.deliver.platform}:${job.deliver.chatId}`,
        ...(job.model ? { model: job.model } : {}),
        ...(job.effort ? { effort: job.effort } : {}),
        ...(job.workspace ? { workspace: job.workspace } : {}),
        skillsMode,
        ...(job.skills ? { skills: job.skills } : {}),
        mcpMode,
        ...(job.mcp ? { mcp: job.mcp } : {}),
        toolsMode,
        ...(job.tools ? { tools: job.tools } : {}),
        nextRunAt: job.nextRunAt,
        lastRunAt: job.lastRunAt,
        lastStatus: job.lastStatus,
        lastError: job.lastError,
        createdAt: job.createdAt,
        unknownModel: job.model !== undefined && !modelIds.has(job.model),
        unknownWorkspace: job.workspace !== undefined && !workspaceKeys.has(job.workspace),
        unknownSkills: (job.skills ?? []).filter((name) => name !== "*" && !skillNames.has(name)),
        unknownMcp: (job.mcp ?? []).filter((name) => name !== "*" && !mcpNames.has(name)),
        unknownTools: (job.tools ?? []).filter((name) => name !== "*" && !toolNames.has(name)),
      };
    });
  };

  const persist = async () => {
    await saveJobs(jobs);
    return wireJobs();
  };

  beforeEach(async () => {
    store = new FakeSessionStore();
    adapter = new MyClawAppAdapter(createConfig(), store as never);
    jobs = [];
    adapter.onMessage(async () => {});
    adapter.onJobsController({
      list: async () => wireJobs(),
      runs: async (jobId) => {
        if (!jobs.some((j) => j.id === jobId)) throw new Error(`job not found: ${jobId}`);
        return [
          {
            threadId: `cron-${jobId}-1700000000000`,
            runAt: 1700000000000,
            messageCount: 3,
            title: `${jobs.find((j) => j.id === jobId)!.name} · run`,
          },
        ];
      },
      save: async (fields) => {
        const jobEffort: import("../src/cron/types.ts").CronJob["effort"] | "" | undefined =
          fields.effort === undefined ? undefined : fields.effort === "" ? "" : (fields.effort as import("../src/core/config.ts").EffortLevel);
        const stored = {
          ...(fields.model ? { model: fields.model } : {}),
          ...(jobEffort === undefined ? {} : { effort: jobEffort }),
          ...(fields.workspace ? { workspace: fields.workspace } : {}),
          skills: fields.skills.mode === "inherit" ? undefined : fields.skills.mode === "all" ? ["*"] : (fields.skills.names ?? []),
          mcp: fields.mcp.mode === "inherit" ? undefined : fields.mcp.mode === "all" ? ["*"] : (fields.mcp.names ?? []),
          tools: fields.tools.mode === "inherit" ? undefined : fields.tools.mode === "all" ? ["*"] : (fields.tools.names ?? []),
        };
        if (fields.id) {
          const target = jobs.find((j) => j.id === fields.id);
          if (!target) throw new Error(`job not found: ${fields.id}`);
          if (fields.skills.mode === "inherit") delete target.skills;
          if (fields.mcp.mode === "inherit") delete target.mcp;
          if (fields.tools.mode === "inherit") delete target.tools;
          const updated = updateJob(jobs, fields.id, { name: fields.name, prompt: fields.prompt, schedule: fields.schedule, enabled: fields.enabled, ...stored });
          if (!updated) throw new Error(`job not found: ${fields.id}`);
        } else {
          jobs.push(createJob({ name: fields.name, prompt: fields.prompt, schedule: fields.schedule, origin: null, deliver: "local", ...stored }));
        }
        return persist();
      },
      remove: async (id) => {
        if (!removeJob(jobs, id)) throw new Error(`job not found: ${id}`);
        return persist();
      },
    });
    await adapter.start();
    client = await connectClient(adapter.port);
  });

  afterEach(async () => {
    client?.ws.close();
    await adapter.stop();
    jobs = [];
  });

  test("jobs.list answers the empty store without a controller is refused on the jobs scope", async () => {
    client.ws.send(JSON.stringify({ type: "jobs.list" }));
    const frame = await nextFrame(client);
    assert.equal(frame["type"], "jobs.list.result");
    assert.deepEqual(frame["jobs"], []);
  });

  test("jobs.runs lists the run sessions of one job, and refuses an unknown job", async () => {
    client.ws.send(JSON.stringify({ type: "jobs.save", name: "Digest", prompt: "sum up", schedule: "every 24h", enabled: true, skills: { mode: "inherit" }, mcp: { mode: "inherit" }, tools: { mode: "inherit" } }));
    await nextFrame(client);
    client.ws.send(JSON.stringify({ type: "jobs.runs", jobId: jobs[0]!.id }));
    const frame = await nextFrame(client);
    assert.equal(frame["type"], "jobs.runs.result");
    assert.equal(frame["jobId"], jobs[0]!.id);
    const runs = frame["runs"] as Array<Record<string, unknown>>;
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!["threadId"], `cron-${jobs[0]!.id}-1700000000000`);

    client.ws.send(JSON.stringify({ type: "jobs.runs", jobId: "unknown000000" }));
    const refused = await nextFrame(client);
    assert.equal(refused["type"], "error");
    assert.equal(refused["scope"], "jobs");
  });

  test("jobs.save creates a job: local delivery, scope stored, unknown model flagged but saved", async () => {
    client.ws.send(JSON.stringify({
      type: "jobs.save",
      name: "Morning report",
      prompt: "Summarize the house sensors",
      schedule: "every 24h",
      enabled: true,
      model: "ghost-model",
      skills: { mode: "list", names: ["code-review", "vanished-skill"] },
      mcp: { mode: "all" },
      tools: { mode: "inherit" },
    }));
    const frame = await nextFrame(client);
    assert.equal(frame["type"], "jobs.list.result");
    const listed = (frame["jobs"] as Array<Record<string, unknown>>);
    assert.equal(listed.length, 1);
    const job = listed[0]!;
    assert.equal(job["deliver"], "local");
    assert.equal((job["schedule"] as { kind: string })["kind"], "interval");
    assert.equal(job["enabled"], true);
    assert.equal(job["model"], "ghost-model");
    assert.equal(job["unknownModel"], true, "a stale model is painted red, not refused");
    assert.equal(job["unknownWorkspace"], false);
    assert.deepEqual(job["unknownSkills"], ["vanished-skill"]);
    assert.equal(job["skillsMode"], "list");
    assert.equal(job["mcpMode"], "all");
    assert.equal(job["toolsMode"], "inherit");
    assert.equal(jobs.length, 1);
  });

  test("jobs.save carries the effort pin and an empty string clears it", async () => {
    client.ws.send(JSON.stringify({
      type: "jobs.save",
      name: "Digest",
      prompt: "sum up",
      schedule: "every 24h",
      enabled: true,
      model: "fast-1",
      effort: "high",
      skills: { mode: "inherit" },
      mcp: { mode: "inherit" },
      tools: { mode: "inherit" },
    }));
    const frame = await nextFrame(client);
    const listed = (frame["jobs"] as Array<Record<string, unknown>>);
    assert.equal(listed[0]!["effort"], "high");

    client.ws.send(JSON.stringify({
      type: "jobs.save",
      id: (listed[0]!["id"] as string),
      name: "Digest",
      prompt: "sum up",
      schedule: "every 24h",
      enabled: true,
      effort: "",
      skills: { mode: "inherit" },
      mcp: { mode: "inherit" },
      tools: { mode: "inherit" },
    }));
    const frame2 = await nextFrame(client);
    const cleared = (frame2["jobs"] as Array<Record<string, unknown>>);
    assert.equal(cleared[0]!["effort"], undefined);
  });

  test("jobs.save updates by id and keeps the untouched scope fields", async () => {
    const first = createJob({ name: "Old", prompt: "do the thing", schedule: "every 1h", origin: null, deliver: "local", model: "fast-1", skills: ["code-review"] });
    jobs.push(first);
    await saveJobs(jobs);

    client.ws.send(JSON.stringify({
      type: "jobs.save",
      id: first.id,
      name: "New name",
      prompt: "do the other thing",
      schedule: "0 9 * * 1",
      enabled: false,
      tools: { mode: "list", names: ["bash"] },
      skills: { mode: "inherit" },
      mcp: { mode: "inherit" },
    }));
    const frame = await nextFrame(client);
    const listed = (frame["jobs"] as Array<Record<string, unknown>>);
    assert.equal(listed.length, 1);
    assert.equal(listed[0]!["name"], "New name");
    assert.equal(listed[0]!["enabled"], false);
    assert.equal((listed[0]!["schedule"] as { kind: string })["kind"], "cron");
    assert.deepEqual(listed[0]!["tools"], ["bash"]);
    // skills was cleared to inherit, model untouched by the update.
    assert.equal(listed[0]!["skillsMode"], "inherit");
    assert.equal(listed[0]!["model"], "fast-1");
    assert.equal(jobs[0]!.name, "New name");
  });

  test("a schedule that does not parse is refused on the jobs scope", async () => {
    client.ws.send(JSON.stringify({
      type: "jobs.save",
      name: "Broken",
      prompt: "run something",
      schedule: "not a schedule",
      enabled: true,
      skills: { mode: "inherit" },
      mcp: { mode: "inherit" },
      tools: { mode: "inherit" },
    }));
    const frame = await nextFrame(client);
    assert.equal(frame["type"], "error");
    assert.equal(frame["scope"], "jobs");
    assert.equal(jobs.length, 0, "nothing was saved");
  });

  test("jobs.save without prompt or schedule is refused before the store is touched", async () => {
    client.ws.send(JSON.stringify({ type: "jobs.save", name: "Empty", prompt: "", schedule: "", enabled: true, skills: { mode: "inherit" }, mcp: { mode: "inherit" }, tools: { mode: "inherit" } }));
    const frame = await nextFrame(client);
    assert.equal(frame["type"], "error");
    assert.equal(frame["scope"], "jobs");
  });

  test("jobs.delete removes a job and answers the fresh listing; an unknown id is refused", async () => {
    const first = createJob({ name: "One", prompt: "a", schedule: "every 30m", origin: null, deliver: "local" });
    jobs.push(first);
    await saveJobs(jobs);

    client.ws.send(JSON.stringify({ type: "jobs.delete", id: first.id }));
    let frame = await nextFrame(client);
    assert.equal(frame["type"], "jobs.list.result");
    assert.deepEqual(frame["jobs"], []);
    assert.equal(jobs.length, 0);

    client.ws.send(JSON.stringify({ type: "jobs.delete", id: "ghost" }));
    frame = await nextFrame(client);
    assert.equal(frame["type"], "error");
    assert.equal(frame["scope"], "jobs");
  });

  test("a jobs frame without a controller answers an error instead of hanging", async () => {
    const bare = new MyClawAppAdapter(createConfig(), store as never);
    await bare.start();
    try {
      const c = await connectClient(bare.port);
      c.ws.send(JSON.stringify({ type: "jobs.list" }));
      const frame = await nextFrame(c);
      assert.equal(frame["type"], "error");
      assert.equal(frame["scope"], "jobs");
      c.ws.close();
    } finally {
      await bare.stop();
    }
  });
});

describe("subagents frames", () => {
  let adapter: MyClawAppAdapter;
  let client: WsClient;
  let store: FakeSessionStore;
  let asked: string[];

  const entry = (id: string, over: Record<string, unknown> = {}) => ({
    threadId: `sub-${id.slice(-16).padStart(16, "0")}`,
    id,
    displayName: id.slice("subagent/".length).replace(/-[0-9a-f]{4}$/, ""),
    type: "research",
    messageCount: 4,
    status: "idle" as const,
    visibility: "global" as const,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...over,
  });

  beforeEach(async () => {
    store = new FakeSessionStore();
    adapter = new MyClawAppAdapter(createConfig(), store as never);
    asked = [];
    adapter.onMessage(async () => {});
    await adapter.start();
    client = await connectClient(adapter.port);
  });

  afterEach(async () => {
    client?.ws.close();
    await adapter.stop();
  });

  const controller = (over: Partial<Parameters<typeof adapter.onSubAgentsController>[0]> = {}) => ({
    list: async (callerSessionId: string) => {
      asked.push(`list:${callerSessionId}`);
      return [entry("subagent/research-a1b2"), entry("subagent/writer-c3d4", { status: "running" })];
    },
    kill: async (threadId: string, caller: string) => {
      asked.push(`kill:${threadId}:${caller}`);
      return `Sub-agent ${threadId} deleted.`;
    },
    reset: async (threadId: string, caller: string) => {
      asked.push(`reset:${threadId}:${caller}`);
      return `Sub-agent ${threadId} session reset. Workspace preserved.`;
    },
    ...over,
  });

  test("subagents.list answers the roster for the asking conversation's session", async () => {
    adapter.onSubAgentsController(controller({
      list: async (callerSessionId: string) => {
        asked.push(`list:${callerSessionId}`);
        return [entry("subagent/research-a1b2"), entry("subagent/writer-c3d4", { status: "running" })];
      },
    }));
    client.ws.send(JSON.stringify({ type: "subagents.list", threadId: "main" }));
    const frame = await nextFrame(client);
    assert.equal(frame["type"], "subagents.list.result");
    assert.equal(frame["threadId"], "main");
    const agents = frame["agents"] as Array<Record<string, unknown>>;
    assert.equal(agents.length, 2);
    assert.equal(agents[0]!["id"], "subagent/research-a1b2");
    assert.equal(agents[1]!["status"], "running");
    // The scoping rule lives in the runner, so what matters here is that the caller's session
    // is the one handed to it -- not the raw thread id.
    assert.deepEqual(asked, ["list:my-claw-app/thread/test-device/main"]);
  });

  test("subagents.list refuses an invalid threadId on its own scope", async () => {
    adapter.onSubAgentsController(controller({ list: async () => [] }));
    client.ws.send(JSON.stringify({ type: "subagents.list", threadId: "../etc/passwd" }));
    const frame = await nextFrame(client);
    assert.equal(frame["type"], "error");
    assert.equal(frame["scope"], "subagents");
  });

  test("subagents.list without a provider is refused rather than answered empty", async () => {
    client.ws.send(JSON.stringify({ type: "subagents.list", threadId: "main" }));
    const frame = await nextFrame(client);
    assert.equal(frame["type"], "error");
    assert.equal(frame["scope"], "subagents");
    // An empty roster and an unavailable one are different states: the header counter must not
    // claim zero sub-agents because the wiring is missing.
    assert.match(String(frame["message"]), /unavailable/);
  });

  test("a failing roster is reported, not swallowed", async () => {
    adapter.onSubAgentsController(controller({
      list: async () => {
        throw new Error("disk on fire");
      },
    }));
    client.ws.send(JSON.stringify({ type: "subagents.list", threadId: "main" }));
    const frame = await nextFrame(client);
    assert.equal(frame["type"], "error");
    assert.equal(frame["scope"], "subagents");
  });

  test("kill and reset carry the asking conversation as the caller and answer with the roster", async () => {
    adapter.onSubAgentsController(controller());
    for (const type of ["subagents.kill", "subagents.reset"] as const) {
      asked.length = 0;
      client.ws.send(JSON.stringify({ type, threadId: "sub-0123456789abcdef", parentThreadId: "main" }));
      const frame = await nextFrame(client);
      // Answered with the resulting roster, not an acknowledgement: the device renders what the
      // server did rather than what it hoped for.
      assert.equal(frame["type"], "subagents.list.result");
      assert.equal(frame["threadId"], "main");
      assert.equal((frame["agents"] as unknown[]).length, 2);
      const action = type.slice("subagents.".length);
      assert.deepEqual(asked, [
        `${action}:sub-0123456789abcdef:my-claw-app/thread/test-device/main`,
        "list:my-claw-app/thread/test-device/main",
      ]);
    }
  });

  test("a refused kill is an error, and nothing is re-listed", async () => {
    adapter.onSubAgentsController(controller({
      kill: async (threadId: string) => {
        asked.push(`kill:${threadId}`);
        return "Error: sub-agent sub-0123456789abcdef not found.";
      },
    }));
    client.ws.send(JSON.stringify({ type: "subagents.kill", threadId: "sub-0123456789abcdef", parentThreadId: "main" }));
    const frame = await nextFrame(client);
    assert.equal(frame["type"], "error");
    assert.equal(frame["scope"], "subagents");
    assert.match(String(frame["message"]), /not found/);
    // The attempt happened and stopped there: no roster is sent after a refusal, so the app cannot
    // read one as confirmation.
    assert.deepEqual(asked, ["kill:sub-0123456789abcdef"]);
  });

  test("kill and reset need both thread ids", async () => {
    adapter.onSubAgentsController(controller());
    client.ws.send(JSON.stringify({ type: "subagents.kill", threadId: "sub-0123456789abcdef", parentThreadId: "../etc" }));
    const frame = await nextFrame(client);
    assert.equal(frame["type"], "error");
    assert.equal(frame["scope"], "subagents");
    assert.deepEqual(asked, []);
  });
});

describe("notifications", () => {
  let adapter: MyClawAppAdapter;
  let client: WsClient;
  const registrations: Array<{ deviceId: string; endpoint?: string; pubKey?: string; auth?: string }> = [];
  const states: Array<{ deviceId: string; foreground: boolean; threadId?: string }> = [];

  const until = async (predicate: () => boolean, timeoutMs = 3000): Promise<void> => {
    const start = Date.now();
    while (!predicate()) {
      if (Date.now() - start > timeoutMs) throw new Error("condition not met within timeout");
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  beforeEach(async () => {
    adapter = new MyClawAppAdapter(createConfig(), new FakeSessionStore() as never);
    adapter.onMessage(async () => {});
    adapter.onNotificationsController({
      info: async () => "vapid-public-key",
      register: async (deviceId, frame) => { registrations.push({ deviceId, endpoint: frame.endpoint, pubKey: frame.pubKey, auth: frame.auth }); },
      unregister: async (deviceId) => { registrations.push({ deviceId, endpoint: undefined }); },
      setForeground: async (deviceId, state) => { states.push({ deviceId, ...state }); },
    });
    await adapter.start();
    client = await connectClient(adapter.port);
  });

  afterEach(async () => {
    client?.ws.close();
    await adapter.stop();
    registrations.length = 0;
    states.length = 0;
  });

  test("a connecting device is greeted with the VAPID public key", async () => {
    const info = await nextFrame(client);
    assert.equal(info["type"], "notifications.info");
    assert.equal(info["vapidPublicKey"], "vapid-public-key");
  });

  test("notifications.register hands the endpoint to the controller", async () => {
    client.ws.send(JSON.stringify({
      type: "notifications.register",
      endpoint: "https://push.example/up/secret",
      pubKey: "pub",
      auth: "auth",
    }));
    await until(() => registrations.length === 1);
    assert.deepEqual(registrations, [{ deviceId: DEVICE_ID, endpoint: "https://push.example/up/secret", pubKey: "pub", auth: "auth" }]);
  });

  test("notifications.register with an empty endpoint unregisters the device", async () => {
    client.ws.send(JSON.stringify({ type: "notifications.register", endpoint: "" }));
    await until(() => registrations.length === 1);
    assert.deepEqual(registrations, [{ deviceId: DEVICE_ID, endpoint: undefined }]);
  });

  test("notifications.state forwards the foreground state", async () => {
    client.ws.send(JSON.stringify({ type: "notifications.state", foreground: true, threadId: "t1" }));
    await until(() => states.length === 1);
    assert.deepEqual(states, [{ deviceId: DEVICE_ID, foreground: true, threadId: "t1" }]);
  });

  test("notifications.register without a controller is refused on the notifications scope", async () => {
    const bare = new MyClawAppAdapter(createConfig(), new FakeSessionStore() as never);
    bare.onMessage(async () => {});
    await bare.start();
    try {
      const c = await connectClient(bare.port);
      c.ws.send(JSON.stringify({ type: "notifications.register", endpoint: "https://x/y" }));
      const frame = await nextFrame(c);
      assert.equal(frame["type"], "error");
      assert.equal(frame["scope"], "notifications");
      c.ws.close();
    } finally {
      await bare.stop();
    }
  });
});
