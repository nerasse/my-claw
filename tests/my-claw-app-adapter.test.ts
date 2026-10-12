import { test, afterEach, beforeEach, describe, spyOn } from "bun:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { filesRootForOwner, SessionFileStore } from "../src/channels/my-claw-app/files.ts";
import { mkdir, writeFile, unlink, readdir, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MyClawAppAdapter } from "../src/channels/my-claw-app/adapter.ts";
import { FsWatchRegistry } from "../src/channels/my-claw-app/fs-ops.ts";
import type { MyClawAppAgentsConfigResult, MyClawAppJobEntry, MyClawAppMcpEntry, MyClawAppSessionInstructionPatch, MyClawAppToolEntry } from "../src/channels/my-claw-app/types.ts";
import type { MyClawAppChannelConfig } from "../src/core/config.ts";
import { runRegistry } from "../src/core/run-registry.ts";
import { withRunContext } from "../src/utils/run-context.ts";
import { MY_CLAW_DIR } from "../src/core/config.ts";
import type { ToolApprovalRequest, UnifiedMessage } from "../src/channels/types.ts";
import { createJob, loadJobs, removeJob, saveJobs, updateJob } from "../src/cron/store.ts";

import { mockFetch } from "./helpers/mock-fetch.ts";
import { buildZip, part } from "./helpers/zip.ts";
import { resetAppUpdateCache } from "../src/channels/my-claw-app/updates.ts";
import { questionManager } from "../src/questions/manager.ts";
import { sessionLogOf } from "../src/sessions/log-access.ts";
import type { UserEntry } from "../src/sessions/log.ts";

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

function connectClient(
  port: number,
  device = DEVICE_ID,
  token = TOKEN,
  receiveLocationCapabilities = false,
  receiveHello = false,
  receiveQuestionPending = false,
  receiveApprovalPending = false,
  receiveReceipts = false,
): Promise<WsClient> {
  return new Promise((resolve, reject) => {
    // The credential in headers, as the app sends it (docs/my-claw-app-channel.md, "Credentials").
    const ws = new WebSocket(`ws://127.0.0.1:${port}/my-claw-app`, {
      headers: { "X-My-Claw-Device": device, Authorization: `Bearer ${token}` },
    } as never);
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
        // Sent as every socket opens: ambient, like the hello (credentials.test.ts covers it).
        if (frame.type === "media.ticket") return;
        if (!receiveQuestionPending && frame.type === "question.pending") return;
        if (!receiveApprovalPending && frame.type === "approval.pending") return;
        // The transport receipt of every send: ambient for a test about anything else.
        if (!receiveReceipts && frame.type === "chat.send.received") return;
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
    // Settled once: a poll left running past its timeout kept shifting frames off the socket and
    // handed the next one to a promise nobody was waiting on any more.
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      reject(new Error("no frame within timeout"));
    }, timeoutMs);
    const check = () => {
      if (settled) return;
      if (client.frames.length > 0) {
        clearTimeout(timer);
        settled = true;
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
  runActive?: (sessionId: string) => boolean;
  onRunActive(check: (sessionId: string) => boolean): void {
    this.runActive = check;
  }
  summaries: Array<{ threadId: string; title: string; messageCount: number; createdAt: string; lastActiveAt: string; lastMessageAt: string; archived?: boolean; folderId?: string }> = [];
  historyMap = new Map<string, Array<{ id: string; role: "user" | "assistant"; text: string; ts: string }>>();
  archived: string[] = [];
  unarchived: string[] = [];
  removed: string[] = [];

  resolveSessionId(deviceId: string, threadId: string): string {
    return `my-claw-app/thread/${deviceId}/${threadId}`;
  }

  /** Sub-agent session -> the conversation it bills to; set by the tests that need a tree. */
  payers = new Map<string, string>();

  async payerOf(sessionId: string): Promise<string | undefined> {
    return this.payers.get(sessionId);
  }

  async ownerThreadOf(sessionId: string): Promise<{ owner: string; threadId: string } | undefined> {
    const segments = sessionId.split("/");
    if (segments[0] !== "my-claw-app" || segments.length < 4) return undefined;
    return { owner: segments[segments.length - 2]!, threadId: segments[segments.length - 1]! };
  }

  async list(deviceId: string): Promise<typeof this.summaries> {
    return this.summaries;
  }

  historyCalls: Array<{ limit?: number; before?: number; lazyReasoning?: boolean }> = [];
  /** Card id -> the output the session would hand back in full. Absent means "not found". */
  toolOutputs = new Map<string, string>();
  reasonings = new Map<string, string>();

  /** `<fromId>..<untilId>` -> the items a folded row stands for. Absent means "not found". */
  runRanges = new Map<string, Array<{ id: string; role: "user" | "assistant"; text: string; ts: string }>>();
  runItemsCalls: Array<{ fromId: string; untilId: string; lazyReasoning?: boolean }> = [];

  async runItems(_deviceId: string, _threadId: string, fromId: string, untilId: string, lazyReasoning?: boolean) {
    this.runItemsCalls.push({ fromId, untilId, ...(lazyReasoning ? { lazyReasoning } : {}) });
    const entries = this.runRanges.get(`${fromId}..${untilId}`);
    return entries ? { entries, found: true } : { entries: [], found: false };
  }

  async toolOutput(_deviceId: string, _threadId: string, cardId: string): Promise<string | null> {
    return this.toolOutputs.get(cardId) ?? null;
  }

  async reasoningOf(_deviceId: string, _threadId: string, bubbleId: string): Promise<string | null> {
    return this.reasonings.get(bubbleId) ?? null;
  }

  async history(
    deviceId: string,
    threadId: string,
    limit?: number,
    before?: number,
    _beforeId?: string,
    _fold?: boolean,
    lazyReasoning?: boolean,
  ): Promise<{
    entries: Array<{ id: string; role: "user" | "assistant"; text: string; ts: string }>;
    hasMore: boolean;
    nextBefore: number;
  }> {
    this.historyCalls.push({ limit, before, ...(lazyReasoning ? { lazyReasoning } : {}) });
    const all = this.historyMap.get(threadId) ?? [];
    const end = Math.max(all.length - (before ?? 0), 0);
    const start = Math.max(end - (limit ?? all.length), 0);
    return { entries: all.slice(start, end), hasMore: start > 0, nextBefore: all.length - start };
  }

  syncCalls: Array<{ since?: string | null; leaf?: string; limit?: number; lazyReasoning?: boolean }> = [];

  async sync(
    deviceId: string,
    threadId: string,
    since?: string | null,
    leaf?: string,
    limit?: number,
    _fold?: boolean,
    lazyReasoning?: boolean,
  ): Promise<{
    entries: Array<{ id: string; role: "user" | "assistant"; text: string; ts: string }>;
    leaf: string | null;
    head: string | null;
    reset?: "unknown-cursor" | "branch-switch";
    truncated?: boolean;
  }> {
    this.syncCalls.push({ since, leaf, limit, ...(lazyReasoning ? { lazyReasoning } : {}) });
    const all = this.historyMap.get(threadId) ?? [];
    const head = all.length > 0 ? all[all.length - 1]!.id : null;
    return { entries: all, leaf: head, head, ...(this.lastRun ? { lastRun: this.lastRun } : {}) };
  }

  lastRun?: { id: string; status: "running" | "done" | "aborted" | "error" | "interrupted"; startTs: string; endTs?: string };

  journal: Array<{ threadId: string; input: string; output: string; details?: string; sourceId?: string }> = [];

  async recordCommand(deviceId: string, threadId: string, input: string, output: string, details?: string, sourceId?: string): Promise<void> {
    this.journal.push({ threadId, input, output, ...(details ? { details } : {}), ...(sourceId ? { sourceId } : {}) });
  }

  failures: Array<{ threadId: string; error: string }> = [];

  async recordFailure(deviceId: string, threadId: string, error: string): Promise<void> {
    this.failures.push({ threadId, error });
  }

  patches: Array<{ threadId: string; patch: MyClawAppSessionInstructionPatch }> = [];

  async setInstructionPatch(deviceId: string, threadId: string, patch: MyClawAppSessionInstructionPatch): Promise<void> {
    this.patches.push({ threadId, patch });
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

  async rename(deviceId: string, threadId: string, title: string): Promise<void> {
    const entry = this.summaries.find((summary) => summary.threadId === threadId);
    if (!entry) throw new Error("conversation not found");
    entry.title = title.trim() || "(new conversation)";
  }

  folderList: Array<{ id: string; name: string; rank: number; workspace?: string }> = [];
  private folderSeq = 0;

  async folders(_owner: string): Promise<Array<{ id: string; name: string; rank: number; workspace?: string }>> {
    return [...this.folderList];
  }

  /**
   * The real store's two rules that the frames can be refused for, kept here so the adapter's
   * error path is exercised against the same reasons the owner would read.
   */
  async createFolder(_owner: string, name: string, workspace?: string): Promise<{ id: string; name: string; rank: number; workspace?: string }> {
    const clean = name.trim();
    if (!clean) throw new Error("a folder needs a name");
    if (this.folderList.some((folder) => folder.name.toLowerCase() === clean.toLowerCase())) {
      throw new Error(`a folder named "${clean}" already exists`);
    }
    const folder = { id: `folder-${++this.folderSeq}`, name: clean, rank: this.folderList.length, ...(workspace ? { workspace } : {}) };
    this.folderList.push(folder);
    return folder;
  }

  async renameFolder(_owner: string, folderId: string, name: string): Promise<void> {
    const folder = this.folderList.find((entry) => entry.id === folderId);
    if (!folder) throw new Error("folder not found");
    folder.name = name.trim();
  }

  async removeFolder(_owner: string, folderId: string): Promise<number> {
    const before = this.folderList.length;
    this.folderList = this.folderList.filter((folder) => folder.id !== folderId).map((folder, rank) => ({ ...folder, rank }));
    if (this.folderList.length === before) return 0;
    let unfiled = 0;
    for (const summary of this.summaries) {
      if (summary.folderId !== folderId) continue;
      delete summary.folderId;
      unfiled += 1;
    }
    return unfiled;
  }

  async reorderFolders(_owner: string, folderIds: string[]): Promise<void> {
    const head = folderIds.map((id) => this.folderList.find((folder) => folder.id === id)).filter((folder) => folder !== undefined);
    const tail = this.folderList.filter((folder) => !head.includes(folder));
    this.folderList = [...head, ...tail].map((folder, rank) => ({ ...folder, rank }));
  }

  async setFolder(_owner: string, threadId: string, folderId: string | null): Promise<void> {
    const entry = this.summaries.find((summary) => summary.threadId === threadId);
    if (!entry) throw new Error("conversation not found");
    if (folderId === null) {
      delete entry.folderId;
      return;
    }
    if (!this.folderList.some((folder) => folder.id === folderId)) throw new Error("folder not found");
    entry.folderId = folderId;
  }

  drafts = new Map<string, string>();
  draftFlushes = 0;

  async setDraft(deviceId: string, threadId: string, text: string): Promise<{ changed: boolean; ts: number }> {
    const key = `${deviceId}/${threadId}`;
    if ((this.drafts.get(key) ?? "") === text) return { changed: false, ts: 0 };
    if (text) this.drafts.set(key, text);
    else this.drafts.delete(key);
    return { changed: true, ts: 1_700_000_000_000 };
  }

  async clearDraft(deviceId: string, threadId: string): Promise<boolean> {
    return this.drafts.delete(`${deviceId}/${threadId}`);
  }

  async flushDrafts(): Promise<void> {
    this.draftFlushes += 1;
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

  /**
   * What one turn shows: the refs its answer wrote, then the media its tools attached. The two
   * used to be exclusive -- any `MEDIA:` ref dropped every programme attachment -- which kept a
   * delivered file's screenshots off the live bubble and showed them only on reload. Measured on
   * thread 3fad6e60: four turns delivered a PDF or a letter by `MEDIA:` while their tools attached
   * 3 to 6 browser captures the prose never named.
   */
  test("a run's media the answer does not name rides the bubble with it, as a replay shows it", async () => {
    const tmpDir = join(MY_CLAW_DIR, "tmp");
    await mkdir(tmpDir, { recursive: true });
    const stamp = Date.now();
    const letterName = `letter-${stamp}.pdf`;
    const shotOne = `shot-one-${stamp}.png`;
    const shotTwo = `shot-two-${stamp}.png`;
    const letter = join(tmpDir, letterName);
    await writeFile(letter, "pdf-bytes");
    await writeFile(join(tmpDir, shotOne), "shot-one-bytes");
    await writeFile(join(tmpDir, shotTwo), "shot-two-bytes");

    await adapter.send(DEVICE_ID, {
      text: `MEDIA:${letter} voila la lettre`,
      attachments: [
        { type: "image", path: join(tmpDir, shotOne) },
        { type: "image", path: join(tmpDir, shotTwo) },
      ],
    });

    const frame = (await nextFrame(client)) as { text: string; attachments: Array<{ filename: string }> };
    assert.equal(frame.text, "voila la lettre");
    assert.deepEqual(frame.attachments.map((a) => a.filename).sort(), [letterName, shotOne, shotTwo].sort());
  });

  /**
   * The duplicate, the other way round: a voice note the run's TTS produced and the answer
   * delivered after copying it out of the tool's scratch dir are one content under two names, and
   * the store keeps both copies by contract. The bubble must draw the voice once -- the name the
   * answer gave it -- live exactly as on reload (2026-09-23, the starter-kit thread).
   */
  test("a copy the answer already named is not drawn again behind it", async () => {
    const bytes = new TextEncoder().encode("le son de la reponse");
    const tmpDir = join(MY_CLAW_DIR, "tmp");
    await mkdir(tmpDir, { recursive: true });
    const stamp = Date.now();
    // What the answer names: the copy the agent made to deliver the voice.
    const namedName = `reponse-vocale-${stamp}.mp3`;
    const namedPath = join(tmpDir, namedName);
    await writeFile(namedPath, bytes);
    // What the run attached: the tool's own copy of the same voice, stored and paired by the end
    // marker -- the id is what the frame carries.
    const runCopyPath = join(tmpDir, `output-${stamp}.mp3`);
    await writeFile(runCopyPath, bytes);
    const files = new SessionFileStore();
    const runCopy = await files.saveFromPath(DEVICE_ID, "default", runCopyPath);

    await adapter.send(DEVICE_ID, {
      text: `MEDIA:${namedPath} voila`,
      attachments: [{ type: "audio", path: runCopyPath, id: runCopy.id }],
    });

    const frame = (await nextFrame(client)) as { attachments: Array<{ id: string; filename: string }> };
    assert.equal(frame.attachments.length, 1);
    assert.equal(frame.attachments[0]!.filename, namedName);
  });

  /**
   * What a reader shows travels inline, so a WebView or an `<img>` gets a document and not a
   * download; what it saves stays an attachment. Range is what lets pdf.js and a video seek, and
   * it is what a resumed download needs -- docs/file-preview.md.
   */
  test("what renders is served inline and answers Range; what is saved stays an attachment", async () => {
    const tmpDir = join(MY_CLAW_DIR, "tmp");
    await mkdir(tmpDir, { recursive: true });
    const stamp = Date.now();
    const shot = join(tmpDir, `inline-${stamp}.png`);
    const bundle = join(tmpDir, `bundle-${stamp}.zip`);
    await writeFile(shot, "png-bytes");
    await writeFile(bundle, "zip-bytes");

    await adapter.send(DEVICE_ID, {
      text: "here",
      attachments: [
        { type: "image", path: shot },
        { type: "file", path: bundle },
      ],
    });
    const frame = (await nextFrame(client)) as { attachments: Array<{ id: string; filename: string }> };
    const imageId = frame.attachments.find((a) => a.filename.endsWith(".png"))!.id;
    const zipId = frame.attachments.find((a) => a.filename.endsWith(".zip"))!.id;

    const image = await fetch(`http://127.0.0.1:${adapter.port}/media/${imageId}?device=${DEVICE_ID}&token=${TOKEN}`);
    assert.equal(image.status, 200);
    assert.ok(image.headers.get("content-disposition")?.startsWith("inline;"), "a picture is shown, not saved");
    assert.equal(image.headers.get("accept-ranges"), "bytes");
    assert.equal(image.headers.get("x-content-type-options"), "nosniff");
    assert.equal(image.headers.get("content-length"), "9");

    const saved = await fetch(`http://127.0.0.1:${adapter.port}/media/${zipId}?device=${DEVICE_ID}&token=${TOKEN}`);
    assert.equal(saved.status, 200);
    assert.ok(saved.headers.get("content-disposition")?.startsWith("attachment;"), "an archive is saved, not shown");

    const partial = await fetch(`http://127.0.0.1:${adapter.port}/media/${imageId}?device=${DEVICE_ID}&token=${TOKEN}`, {
      headers: { range: "bytes=0-3" },
    });
    assert.equal(partial.status, 206);
    assert.equal(partial.headers.get("content-range"), "bytes 0-3/9");
    assert.equal(partial.headers.get("content-length"), "4");
    assert.equal(await partial.text(), "png-");
  });

  test("a page served inline cannot run anything, whatever opens it", async () => {
    const tmpDir = join(MY_CLAW_DIR, "tmp");
    await mkdir(tmpDir, { recursive: true });
    const page = join(tmpDir, `page-${Date.now()}.html`);
    await writeFile(page, "<!doctype html><html><body><script>alert(1)</script>hi</body></html>");

    await adapter.send(DEVICE_ID, { text: "page", attachments: [{ type: "file", path: page }] });
    const frame = (await nextFrame(client)) as { attachments: Array<{ id: string }> };
    const served = await fetch(`http://127.0.0.1:${adapter.port}/media/${frame.attachments[0]!.id}?device=${DEVICE_ID}&token=${TOKEN}`);

    assert.equal(served.headers.get("content-type"), "text/html");
    assert.equal(served.headers.get("content-security-policy"), "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:");
  });

  /**
   * What the app cannot decode travels as something it can: the text of a document, the entry
   * list of an archive. Both are read out of the bytes, and the file itself is untouched --
   * Download still hands over the document.
   */
  test("a document is served as its text, and an archive as its entry list", async () => {
    const tmpDir = join(MY_CLAW_DIR, "tmp");
    await mkdir(tmpDir, { recursive: true });
    const stamp = Date.now();
    const docx = join(tmpDir, `letter-${stamp}.docx`);
    await writeFile(
      docx,
      buildZip([
        part("word/document.xml", "<w:document><w:body><w:p><w:r><w:t>Bonjour le monde</w:t></w:r></w:p></w:body></w:document>"),
      ]),
    );
    const archive = join(tmpDir, `bundle-${stamp}.zip`);
    await writeFile(archive, buildZip([part("readme.txt", "hello"), part("src/main.ts", "code")]));

    await adapter.send(DEVICE_ID, {
      text: "docs",
      attachments: [
        { type: "file", path: docx },
        { type: "file", path: archive },
      ],
    });
    const frame = (await nextFrame(client)) as { attachments: Array<{ id: string; filename: string; kind?: string }> };
    const docxId = frame.attachments.find((a) => a.filename.endsWith(".docx"))!.id;
    const zipId = frame.attachments.find((a) => a.filename.endsWith(".zip"))!.id;
    assert.equal(frame.attachments.find((a) => a.filename.endsWith(".docx"))!.kind, "office");
    assert.equal(frame.attachments.find((a) => a.filename.endsWith(".zip"))!.kind, "archive");

    const text = await fetch(`http://127.0.0.1:${adapter.port}/media/${docxId}?device=${DEVICE_ID}&token=${TOKEN}&view=text`);
    assert.equal(text.status, 200);
    assert.equal(text.headers.get("content-type"), "text/plain; charset=utf-8");
    assert.equal(await text.text(), "Bonjour le monde");

    const listing = await fetch(`http://127.0.0.1:${adapter.port}/media/${zipId}?device=${DEVICE_ID}&token=${TOKEN}&view=list`);
    assert.equal(listing.status, 200);
    const payload = (await listing.json()) as { entries: Array<{ name: string }> };
    assert.deepEqual(payload.entries.map((entry) => entry.name), ["readme.txt", "src/main.ts"]);

    // The file itself is what a plain fetch still hands over: the conversion never rewrites it.
    const original = await fetch(`http://127.0.0.1:${adapter.port}/media/${docxId}?device=${DEVICE_ID}&token=${TOKEN}`);
    assert.equal(original.headers.get("content-type"), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  });

  /**
   * The platform image view decodes what Android decodes and nothing else: a bmp, a tiff or an
   * ico is converted on the way out, through the ffmpeg already here for video thumbnails. The
   * store keeps the original bytes.
   */
  test("a picture the phone cannot decode is served as a PNG", async () => {
    const tmpDir = join(MY_CLAW_DIR, "tmp");
    await mkdir(tmpDir, { recursive: true });
    const bmp = join(tmpDir, `picture-${Date.now()}.bmp`);
    await execFileAsync("ffmpeg", ["-y", "-f", "lavfi", "-i", "color=c=red:s=4x4", "-frames:v", "1", bmp]);

    await adapter.send(DEVICE_ID, { text: "img", attachments: [{ type: "image", path: bmp }] });
    const frame = (await nextFrame(client)) as { attachments: Array<{ id: string; kind?: string; filename: string }> };
    assert.equal(frame.attachments[0]!.kind, "image");

    const served = await fetch(
      `http://127.0.0.1:${adapter.port}/media/${frame.attachments[0]!.id}?device=${DEVICE_ID}&token=${TOKEN}`,
    );
    assert.equal(served.status, 200);
    assert.equal(served.headers.get("content-type"), "image/png");
    const bytes = new Uint8Array(await served.arrayBuffer());
    assert.deepEqual(
      [...bytes.subarray(0, 8)],
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
      "a PNG signature, drawn from a BMP",
    );
    assert.ok(served.headers.get("content-disposition")?.includes(".png"), "the served name says what it is");
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

  test("a window that reloads mid-run is served the turn in flight", async () => {
    // The run announces itself, then answers into a bubble nothing has persisted yet: a phase
    // entry is written when the model call returns, so this text lives only in the frames that
    // were broadcast -- docs/live-turn-replay.md.
    adapter.notifyRun(DEVICE_ID, "default", true);
    assert.equal((await nextFrame(client)).type, "chat.run.start");
    const streamer = adapter.createStreamer(streamerMessage(adapter, "m-live", DEVICE_ID));
    await streamer.push("moitie de reponse");

    // The reload: a brand new socket that never saw any of it, asking for the delta.
    const reloaded = await connectClient(adapter.port);
    reloaded.ws.send(JSON.stringify({ type: "session.sync", threadId: "default" }));

    const seen: Array<Record<string, unknown>> = [];
    // The page comes first and the journal after it, so the replayed bubble lands at the end of
    // the thread rather than before the history it continues.
    while (seen.length < 3) seen.push(await nextFrame(reloaded));
    assert.equal(seen[0]!.type, "session.sync.result");
    assert.equal(seen[1]!.type, "chat.stream.start");
    assert.equal(seen[2]!.type, "chat.stream.delta");
    assert.equal(seen[2]!.text, "moitie de reponse");

    // The run ends: the session owns the turn now, and a second window gets nothing replayed.
    await streamer.finish();
    adapter.notifyRun(DEVICE_ID, "default", false);
    const after = await connectClient(adapter.port);
    after.ws.send(JSON.stringify({ type: "session.sync", threadId: "default" }));
    assert.equal((await nextFrame(after)).type, "session.sync.result");
    await assert.rejects(() => nextFrame(after, 300));

    reloaded.ws.close();
    after.ws.close();
  });

  test("the stop in flight travels with the turn, and is over when the work departs", async () => {
    // The claim is answered once, but a window that reloads while the abort travels is the one
    // whose Stop button came back unpressed: it has to be told, with the same frame the windows
    // watching got -- docs/stop.md, docs/live-turn-replay.md.
    adapter.onStop((sessionId) => runRegistry.stop(sessionId));
    const sessionId = store.resolveSessionId(DEVICE_ID, "default");
    const { end } = runRegistry.startRoot(sessionId);
    try {
      await withRunContext({ runId: "run-live" }, async () => {
        adapter.notifyRun(DEVICE_ID, "default", true);
      });
      assert.equal((await nextFrame(client)).type, "chat.run.start");

      client.ws.send(JSON.stringify({ type: "chat.stop", threadId: "default" }));
      const stopping = await nextFrame(client);
      assert.equal(stopping["type"], "chat.run.stopping");
      assert.equal(stopping["threadId"], "default");
      // Named like its siblings: the run `chat.run.start` announced, held by the journal.
      assert.equal(stopping["run"], "run-live");
      assert.equal((await nextFrame(client))["type"], "chat.command.result");

      // A second press while the abort travels draws nothing: one stop, one frame.
      client.ws.send(JSON.stringify({ type: "chat.stop", threadId: "default" }));
      await new Promise((r) => setTimeout(r, 150));
      assert.equal(client.frames.length, 0, `the second stop must draw nothing: ${JSON.stringify(client.frames)}`);

      // The reload: the frame comes after the page, with the turn in flight.
      const reloaded = await connectClient(adapter.port);
      reloaded.ws.send(JSON.stringify({ type: "session.sync", threadId: "default" }));
      assert.equal((await nextFrame(reloaded)).type, "session.sync.result");
      const replay = await nextFrame(reloaded);
      assert.equal(replay["type"], "chat.run.stopping");
      assert.equal(replay["run"], "run-live");

      // The work departed: the cycle is over, and the state goes with it.
      adapter.notifyRun(DEVICE_ID, "default", false, "aborted");
      assert.equal((await nextFrame(client)).type, "chat.run.end");
      const after = await connectClient(adapter.port);
      after.ws.send(JSON.stringify({ type: "session.sync", threadId: "default" }));
      assert.equal((await nextFrame(after)).type, "session.sync.result");
      await assert.rejects(() => nextFrame(after, 300));

      reloaded.ws.close();
      after.ws.close();
    } finally {
      end();
      runRegistry.clear();
    }
  });

  test("a stop against a compaction is replayed too, though no run was ever open", async () => {
    // A compaction hold opens no journal and shows no turn: the frames a window missed live in
    // the journal, so this is the case a slot living inside one would have lost entirely.
    adapter.onStop((sessionId) => runRegistry.stop(sessionId));
    const sessionId = store.resolveSessionId(DEVICE_ID, "default");
    const held = runRegistry.beginCompaction(sessionId);
    assert.notEqual(held, null);
    try {
      client.ws.send(JSON.stringify({ type: "chat.stop", threadId: "default" }));
      const stopping = await nextFrame(client);
      assert.equal(stopping["type"], "chat.run.stopping");
      assert.equal(stopping["run"], undefined, "a hold has no run to name");
      assert.equal((await nextFrame(client))["type"], "chat.command.result");

      const reloaded = await connectClient(adapter.port);
      reloaded.ws.send(JSON.stringify({ type: "session.sync", threadId: "default" }));
      assert.equal((await nextFrame(reloaded)).type, "session.sync.result");
      assert.equal((await nextFrame(reloaded))["type"], "chat.run.stopping");

      // The compaction settles -- the operation that raised the stop is over.
      held!.release();
      adapter.notifyCompacting(sessionId, undefined);
      const after = await connectClient(adapter.port);
      after.ws.send(JSON.stringify({ type: "session.sync", threadId: "default" }));
      assert.equal((await nextFrame(after)).type, "session.sync.result");
      await assert.rejects(() => nextFrame(after, 300));

      reloaded.ws.close();
      after.ws.close();
    } finally {
      runRegistry.clear();
    }
  });

  test("every send is receipted to the socket that sent it, and the same id sent again is taken once", async () => {
    // A socket a NAT or a VPN switch killed stays OPEN for the browser: the send goes into a hole
    // and nothing says so. The receipt is what the app waits for; a send it never gets one for is
    // offered again, and sending again has to be safe.
    const sender = await connectClient(adapter.port, DEVICE_ID, TOKEN, false, false, false, false, true);
    sender.ws.send(JSON.stringify({ type: "chat.send", id: "m-receipt", text: "bonjour", threadId: "default" }));
    const receipt = await nextFrame(sender);
    assert.deepEqual(receipt, { type: "chat.send.received", threadId: "default", id: "m-receipt" });
    await waitUntil(() => received.length === 1);

    // The other window of the owner gets the mirrored bubble, never the receipt.
    assert.equal((await nextFrame(client)).type, "chat.user");
    await assert.rejects(() => nextFrame(client, 200));

    // The turn is on the branch: sending the same id again is receipted and goes no further.
    const log = await sessionLogOf(store.resolveSessionId(DEVICE_ID, "default"));
    log.append<UserEntry>({ type: "user", prompt: true, text: "bonjour" }, "m-receipt");
    // Flushed before the resend: the duplicate check reads the log the manager holds, and a log
    // reloaded from disk would not carry an append still sitting in memory -- which is how this
    // test failed on a loaded CI runner while passing locally (2026-09-12).
    await log.flush();
    sender.ws.send(JSON.stringify({ type: "chat.send", id: "m-receipt", text: "bonjour", threadId: "default" }));
    assert.deepEqual(await nextFrame(sender), { type: "chat.send.received", threadId: "default", id: "m-receipt" });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(received.length, 1);

    // Parked in a run's mailbox, not yet on the branch: the same rule.
    adapter.notifyRun(DEVICE_ID, "default", true);
    assert.equal((await nextFrame(client)).type, "chat.run.start");
    assert.equal((await nextFrame(sender)).type, "chat.run.start");
    sender.ws.send(JSON.stringify({ type: "chat.send", id: "m-parked-twice", text: "encore", threadId: "default" }));
    assert.equal((await nextFrame(sender)).type, "chat.send.received");
    await waitUntil(() => received.length === 2);
    adapter.notifyQueued(DEVICE_ID, "default", "m-parked-twice", "injection");
    assert.equal((await nextFrame(sender)).type, "chat.send.queued");
    sender.ws.send(JSON.stringify({ type: "chat.send", id: "m-parked-twice", text: "encore", threadId: "default" }));
    assert.equal((await nextFrame(sender)).type, "chat.send.received");
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(received.length, 2);
    adapter.notifyRun(DEVICE_ID, "default", false);
    sender.ws.close();
  });

  test("sends of one conversation reach the router in the order they arrived", async () => {
    // The head of a send awaits the disk (the duplicate check opens the session log, an attachment
    // is looked up by id) and each frame used to be handled on its own: two frames a few
    // milliseconds apart reached the router in whichever order the disk answered, which is how a
    // fresh thread's first message could land after its second. Same conversation, same order.
    const sender = await connectClient(adapter.port, DEVICE_ID, TOKEN, false, false, false, false, true);
    const texts = Array.from({ length: 12 }, (_, i) => `burst ${i}`);
    for (const [i, text] of texts.entries()) {
      sender.ws.send(JSON.stringify({ type: "chat.send", id: `burst-${i}`, text, threadId: "burst-thread" }));
    }
    await waitUntil(() => received.length === texts.length);
    assert.deepEqual(received.map((msg) => msg.text), texts);
    sender.ws.close();
  });

  test("a send parked for the run's next turn survives a reload: bubble and mark are replayed", async () => {
    // Reported: a message sent during a run, then a reload before the run reached a turn boundary.
    // The message lived in the run's mailbox and on the sender's screen only, so the reloaded
    // window had no bubble, and the ack that followed the drain had nothing to lift.
    adapter.notifyRun(DEVICE_ID, "default", true);
    assert.equal((await nextFrame(client)).type, "chat.run.start");
    client.ws.send(JSON.stringify({ type: "chat.send", id: "m-parked", text: "et ceci aussi" }));
    await waitUntil(() => received.length === 1);
    // What the router does with a send that lands on a run in flight.
    adapter.notifyQueued(DEVICE_ID, "default", "m-parked", "injection");
    assert.equal((await nextFrame(client)).type, "chat.send.queued");

    const reloaded = await connectClient(adapter.port);
    reloaded.ws.send(JSON.stringify({ type: "session.sync", threadId: "default" }));
    const seen: Array<Record<string, unknown>> = [];
    while (seen.length < 3) seen.push(await nextFrame(reloaded));
    assert.equal(seen[0]!.type, "session.sync.result");
    assert.equal(seen[1]!.type, "chat.user");
    assert.equal(seen[1]!.id, "m-parked");
    assert.equal(seen[1]!.text, "et ceci aussi");
    assert.equal(seen[2]!.type, "chat.send.queued");
    assert.equal(seen[2]!.replyToId, "m-parked");

    // The drain: the entry is on the log from here, so the next window is served by the page.
    adapter.notifyAcked(DEVICE_ID, "default", "m-parked");
    const after = await connectClient(adapter.port);
    after.ws.send(JSON.stringify({ type: "session.sync", threadId: "default" }));
    assert.equal((await nextFrame(after)).type, "session.sync.result");
    await assert.rejects(() => nextFrame(after, 300));

    adapter.notifyRun(DEVICE_ID, "default", false);
    reloaded.ws.close();
    after.ws.close();
  });

  test("a run announced twice is one run: the journal in flight is kept, one start and one end go out", async () => {
    // Reported: a message sent during a run made the reloaded window lose the tools in flight, and
    // the run's end rang twice. Every message handler used to announce the run, and the second
    // announcement replaced the journal the first had been filling.
    adapter.notifyRun(DEVICE_ID, "default", true);
    assert.equal((await nextFrame(client)).type, "chat.run.start");
    const streamer = adapter.createStreamer(streamerMessage(adapter, "m-first", DEVICE_ID));
    await streamer.push("travail en cours");
    assert.equal((await nextFrame(client)).type, "chat.stream.start");
    assert.equal((await nextFrame(client)).type, "chat.stream.delta");

    // The same run, announced again: nothing on the wire, nothing lost.
    adapter.notifyRun(DEVICE_ID, "default", true);
    await assert.rejects(() => nextFrame(client, 300));
    const reloaded = await connectClient(adapter.port);
    reloaded.ws.send(JSON.stringify({ type: "session.sync", threadId: "default" }));
    const seen: Array<Record<string, unknown>> = [];
    while (seen.length < 3) seen.push(await nextFrame(reloaded));
    assert.equal(seen[1]!.type, "chat.stream.start");
    assert.equal(seen[2]!.text, "travail en cours");

    // Two ends for one run: the first is the run's, the second is nobody's.
    await streamer.finish();
    while ((await nextFrame(client)).type !== "chat.stream.done") { /* the bubble's own closing frames */ }
    adapter.notifyRun(DEVICE_ID, "default", false, "done");
    assert.equal((await nextFrame(client)).type, "chat.run.end");
    adapter.notifyRun(DEVICE_ID, "default", false, "done");
    await assert.rejects(() => nextFrame(client, 300));
    reloaded.ws.close();
  });

  test("a send parked behind a compaction is acked by the run it opens, and the stale mark is not replayed", async () => {
    // The router holds a send while a compaction rewrites the history, then routes it as the next
    // run's trigger. Nothing drains it through a turn boundary, so nothing acked it: the sender
    // saw "queued" for the whole run, and a reload was replayed the mark on top of the entry.
    client.ws.send(JSON.stringify({ type: "chat.send", id: "m-held", text: "pendant la compaction" }));
    await waitUntil(() => received.length === 1);
    adapter.notifyQueued(DEVICE_ID, "default", "m-held", "compaction");
    assert.equal((await nextFrame(client)).type, "chat.send.queued");

    adapter.notifyRun(DEVICE_ID, "default", true, undefined, "m-held");
    const acked = await nextFrame(client);
    assert.equal(acked.type, "chat.send.acked");
    assert.equal(acked.replyToId, "m-held");
    assert.equal((await nextFrame(client)).type, "chat.run.start");

    const reloaded = await connectClient(adapter.port);
    reloaded.ws.send(JSON.stringify({ type: "session.sync", threadId: "default" }));
    assert.equal((await nextFrame(reloaded)).type, "session.sync.result");
    await assert.rejects(() => nextFrame(reloaded, 300));

    // A send the run did not open is left alone: no ack for it.
    adapter.notifyRun(DEVICE_ID, "default", false, "done");
    assert.equal((await nextFrame(client)).type, "chat.run.end");
    adapter.notifyRun(DEVICE_ID, "default", true, undefined, "m-never-queued");
    assert.equal((await nextFrame(client)).type, "chat.run.start");
    adapter.notifyRun(DEVICE_ID, "default", false, "done");
    assert.equal((await nextFrame(client)).type, "chat.run.end");
    reloaded.ws.close();
  });

  /**
   * The mark must be liftable even when the journal has no bubble for it.
   *
   * Observed worse than theoretical on 2026-09-11: a run whose compaction held the send marked the
   * bubble, and `recentSends` no longer held it, so `holdQueued` was skipped and the run's ack had
   * nothing to fire on. The device kept "waiting for the compaction" until the run ended, and the
   * journal replayed the mark on every reconnect.
   */
  test("a send marked with no bubble in the cache is still acked by the run it opens", async () => {
    // No `chat.send` first: nothing was ever echoed into `recentSends` for this id.
    adapter.notifyQueued(DEVICE_ID, "default", "m-cold", "compaction");
    assert.equal((await nextFrame(client)).type, "chat.send.queued");

    adapter.notifyRun(DEVICE_ID, "default", true, undefined, "m-cold");
    const acked = await nextFrame(client);
    assert.equal(acked.type, "chat.send.acked");
    assert.equal((await nextFrame(client)).type, "chat.run.start");

    // And the mark is gone from the journal: a reload is not handed it again.
    const reloaded = await connectClient(adapter.port);
    reloaded.ws.send(JSON.stringify({ type: "session.sync", threadId: "default" }));
    assert.equal((await nextFrame(reloaded)).type, "session.sync.result");
    await assert.rejects(() => nextFrame(reloaded, 300));
    reloaded.ws.close();
  });

  test("the replayed bubble arrives whole, so a window that was already watching does not paint it twice", async () => {
    // The window asking for a sync is usually the one that was watching a second ago: a blip, a
    // thread switched away from and back, a refresh. It still holds the bubble, and the client
    // appends what it is handed, so replaying the chunks one by one wrote the turn onto itself.
    adapter.notifyRun(DEVICE_ID, "default", true);
    assert.equal((await nextFrame(client)).type, "chat.run.start");
    const streamer = adapter.createStreamer(streamerMessage(adapter, "m-twice", DEVICE_ID));
    await streamer.push("un ");
    await streamer.push("deux ");
    await streamer.push("trois");

    const reloaded = await connectClient(adapter.port);
    reloaded.ws.send(JSON.stringify({ type: "session.sync", threadId: "default" }));

    const seen: Array<Record<string, unknown>> = [];
    while (seen.length < 3) seen.push(await nextFrame(reloaded));
    assert.equal(seen[0]!.type, "session.sync.result");
    assert.equal(seen[1]!.type, "chat.stream.start");

    // One delta, not three, and flagged so the client replaces instead of appending.
    assert.equal(seen[2]!.type, "chat.stream.delta");
    assert.equal(seen[2]!.text, "un deux trois");
    assert.equal(seen[2]!.replay, true);
    await assert.rejects(() => nextFrame(reloaded, 300), "the other two chunks must not follow");

    await streamer.finish();
    adapter.notifyRun(DEVICE_ID, "default", false);
    reloaded.ws.close();
  });

  test("a ping is answered, because that reply is the only proof the link is two-way", async () => {
    // The browser has no transport-level ping and cannot see a dead peer any other way: fifteen
    // bytes still reach the kernel buffer of a socket whose other end is gone, so watching
    // bufferedAmount reported a healthy link forever while every frame fell in a hole.
    client.ws.send(JSON.stringify({ type: "ping" }));
    assert.equal((await nextFrame(client)).type, "pong");
  });

  test("a pending approval is asked again to a window that reloaded", async () => {
    // The sheet is broadcast once. A window that reloads used to lose it, and the tool then waited
    // out its timeout and was denied without the owner ever seeing the question.
    const approvalsAdapter = new MyClawAppAdapter(createConfig({ approvals: true }), store as never);
    approvalsAdapter.onMessage(() => Promise.resolve());
    await approvalsAdapter.start();
    const watching = await connectClient(approvalsAdapter.port);
    approvalsAdapter.notifyRun(DEVICE_ID, "default", true);
    assert.equal((await nextFrame(watching)).type, "chat.run.start");

    const decision = approvalsAdapter.confirmTool(approvalRequest());
    assert.equal((await nextFrame(watching)).type, "approval.request");

    const reloaded = await connectClient(approvalsAdapter.port);
    reloaded.ws.send(JSON.stringify({ type: "session.sync", threadId: "default" }));
    assert.equal((await nextFrame(reloaded)).type, "session.sync.result");
    const sheet = await nextFrame(reloaded);
    assert.equal(sheet.type, "approval.request");

    // Answered from the window that got the replay: the question is gone for everyone.
    reloaded.ws.send(JSON.stringify({ type: "approval.response", id: sheet.id, decision: "deny" }));
    assert.equal(await decision, "deny");
    const other = await connectClient(approvalsAdapter.port);
    other.ws.send(JSON.stringify({ type: "session.sync", threadId: "default" }));
    assert.equal((await nextFrame(other)).type, "session.sync.result");
    await assert.rejects(() => nextFrame(other, 300));

    watching.ws.close();
    reloaded.ws.close();
    other.ws.close();
    await approvalsAdapter.stop();
  });

  test("a pending approval reaches a window that opens on another thread entirely", async () => {
    // The replay above is per thread: it only fires on a `session.sync` of the thread the sheet
    // belongs to. A window opening on another conversation, or an app coming back from sleep on
    // its last thread, saw nothing, and the tool sat out its two minutes and was denied without
    // the owner ever being asked.
    const approvalsAdapter = new MyClawAppAdapter(createConfig({ approvals: true }), store as never);
    approvalsAdapter.onMessage(() => Promise.resolve());
    await approvalsAdapter.start();
    const watching = await connectClient(approvalsAdapter.port);
    approvalsAdapter.notifyRun(DEVICE_ID, "default", true);
    assert.equal((await nextFrame(watching)).type, "chat.run.start");
    const decision = approvalsAdapter.confirmTool(approvalRequest());
    assert.equal((await nextFrame(watching)).type, "approval.request");

    // No sync at all, and no mention of "default": just a socket opening.
    const fresh = await connectClient(approvalsAdapter.port, DEVICE_ID, TOKEN, false, false, false, true);
    const pending = await nextFrame(fresh);
    assert.equal(pending.type, "approval.pending");
    const entries = pending.entries as Array<{ id: string; toolName: string; threadId: string }>;
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.toolName, "bash");
    assert.equal(entries[0]!.threadId, "default");

    fresh.ws.send(JSON.stringify({ type: "approval.response", id: entries[0]!.id, decision: "deny" }));
    assert.equal(await decision, "deny");

    // And once it is settled, the next window is told the list is empty rather than left to guess.
    const after = await connectClient(approvalsAdapter.port, DEVICE_ID, TOKEN, false, false, false, true);
    const cleared = await nextFrame(after);
    assert.equal(cleared.type, "approval.pending");
    assert.deepEqual(cleared.entries, []);

    watching.ws.close();
    fresh.ws.close();
    after.ws.close();
    await approvalsAdapter.stop();
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
      { threadId: "a", title: "salut l'agent", messageCount: 4, createdAt: "t1", lastActiveAt: "t2", lastMessageAt: "t2" },
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
    assert.ok(frame.commands.some((c) => c.name === "new"));
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
      { threadId: "projet", title: "salut ca va", messageCount: 2, createdAt: "c", lastActiveAt: "l", lastMessageAt: "l" },
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

  test("ui prefs can be read and switched from the device", async () => {
    let stored = { expandTools: false, expandReasoning: false };
    adapter.onUiPrefsController({
      status: () => stored,
      set: async (prefs) => {
        stored = { ...stored, ...prefs };
        return stored;
      },
    });

    client.ws.send(JSON.stringify({ type: "uiPrefs.get" }));
    const initial = (await nextFrame(client)) as { type: string; expandTools: boolean; expandReasoning: boolean };
    assert.equal(initial.type, "uiPrefs.result");
    assert.equal(initial.expandTools, false);

    // A set answers with the resulting state, so the app never renders a stale switch.
    client.ws.send(JSON.stringify({ type: "uiPrefs.set", prefs: { expandTools: true } }));
    const after = (await nextFrame(client)) as { type: string; expandTools: boolean; expandReasoning: boolean };
    assert.equal(after.type, "uiPrefs.result");
    assert.equal(after.expandTools, true);
    assert.equal(after.expandReasoning, false);
    assert.equal(stored.expandTools, true);
  });

  test("ui prefs with an invalid value are refused on the uiPrefs scope", async () => {
    adapter.onUiPrefsController({
      status: () => ({ expandTools: false, expandReasoning: false }),
      set: async () => ({ expandTools: false, expandReasoning: false }),
    });

    client.ws.send(JSON.stringify({ type: "uiPrefs.set", prefs: { expandTools: "yes" } }));
    const frame = (await nextFrame(client)) as { type: string; message: string; scope: string };
    assert.equal(frame.type, "error");
    assert.equal(frame.scope, "uiPrefs");
  });

  test("accounts: a token that is not Claude's is refused before it is stored; a failure never echoes the secret", async () => {
    const calls: string[] = [];
    const state = { accounts: [], codex: { connected: false }, claude: { connected: false } };
    adapter.onAccountsController({
      status: async () => state,
      login: async () => state,
      cancel: async () => state,
      add: async () => ({ ...state, added: "x" }),
      rename: async () => state,
      code: async (_provider, code) => {
        calls.push(`code ${code}`);
        throw new Error("Claude OAuth request failed (400)");
      },
      token: async (_provider, token) => {
        calls.push(`token ${token}`);
        return { ...state, claude: { connected: true, source: "token" } };
      },
      logout: async () => state,
    });

    client.ws.send(JSON.stringify({ type: "accounts.token", provider: "anthropic", token: "sk-proj-an-openai-api-key" }));
    const refused = (await nextFrame(client)) as { type: string; scope: string; message: string };
    assert.equal(refused.scope, "accounts");
    assert.match(refused.message, /sk-ant-oat/);
    assert.deepEqual(calls, []);

    const token = `sk-ant-oat01-${"z".repeat(40)}`;
    client.ws.send(JSON.stringify({ type: "accounts.token", provider: "anthropic", token }));
    const stored = (await nextFrame(client)) as { type: string; claude: { connected: boolean } };
    assert.equal(stored.type, "accounts.result");
    assert.equal(stored.claude.connected, true);

    client.ws.send(JSON.stringify({ type: "accounts.code", provider: "anthropic", code: "secret-code#state" }));
    const failed = (await nextFrame(client)) as { type: string; scope: string; message: string };
    assert.equal(failed.scope, "accounts");
    assert.equal(failed.message, "Claude OAuth request failed (400)");
    assert.ok(!JSON.stringify(failed).includes("secret-code"));
  });

  test("services: a get describes them, a set answers with the state written, a refusal names why", async () => {
    const view = (source: string) => ({ id: "search", source, choices: ["off", "url"], missing: [], health: "no-endpoint" });
    const choices: unknown[] = [];
    adapter.onServicesController({
      status: async () => ({ install: "native", services: [view("off")] as never, pushDevices: [], pairedDevices: 1 }),
      set: async (choice) => {
        choices.push(choice);
        return choice.url ? { ok: true, state: { install: "native", services: [view("url")] as never, pushDevices: [], pairedDevices: 1 } } : { ok: false, error: "an http(s) URL is needed" };
      },
      free: async (id) => ({ ok: false, error: `${id} runs on this server: switch it to the cloud or a URL first` }),
    });

    client.ws.send(JSON.stringify({ type: "services.get" }));
    const initial = (await nextFrame(client)) as { type: string; install: string; services: Array<{ source: string }> };
    assert.equal(initial.type, "services.result");
    assert.equal(initial.services[0]!.source, "off");

    client.ws.send(JSON.stringify({ type: "services.set", id: "search", source: "url", url: "http://search.lan" }));
    const after = (await nextFrame(client)) as { type: string; services: Array<{ source: string }> };
    assert.equal(after.type, "services.result");
    assert.equal(after.services[0]!.source, "url");
    assert.deepEqual(choices[0], { id: "search", source: "url", url: "http://search.lan" });

    client.ws.send(JSON.stringify({ type: "services.set", id: "search", source: "url" }));
    const refused = (await nextFrame(client)) as { type: string; scope: string; message: string };
    assert.equal(refused.type, "error");
    assert.equal(refused.scope, "services");
    assert.equal(refused.message, "an http(s) URL is needed");

    client.ws.send(JSON.stringify({ type: "services.free", id: "stt" }));
    const freeRefused = (await nextFrame(client)) as { type: string; scope: string; message: string };
    assert.equal(freeRefused.scope, "services");
    assert.equal(freeRefused.message, "stt runs on this server: switch it to the cloud or a URL first");

    // Only two engines have files: any other id is refused before the controller deletes anything.
    client.ws.send(JSON.stringify({ type: "services.free", id: "browser" }));
    const unknownFree = (await nextFrame(client)) as { type: string; scope: string; message: string };
    assert.equal(unknownFree.message, "only stt and embeddings have files to free");
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

  test("chat.tool.full hands back the output the card was pushed clipped", async () => {
    store.toolOutputs.set("t-call-1", "x".repeat(9000));
    client.ws.send(JSON.stringify({ type: "chat.tool.full", threadId: "a", id: "t-call-1" }));
    const frame = (await nextFrame(client)) as { type: string; threadId: string; id: string; output: string; found: boolean };
    assert.equal(frame.type, "chat.tool.full.result");
    assert.equal(frame.threadId, "a");
    assert.equal(frame.id, "t-call-1");
    assert.equal(frame.found, true);
    assert.equal(frame.output.length, 9000);
  });

  test("chat.tool.full says so when the session no longer holds the call", async () => {
    // A compaction dropped the turn: the app must keep the clipped text it has rather than
    // replace it with an empty block.
    client.ws.send(JSON.stringify({ type: "chat.tool.full", threadId: "a", id: "t-gone" }));
    const frame = (await nextFrame(client)) as { type: string; found: boolean; output: string };
    assert.equal(frame.type, "chat.tool.full.result");
    assert.equal(frame.found, false);
    assert.equal(frame.output, "");
  });

  test("a client that asks for lazy reasoning has it passed on, on every read that draws bubbles", async () => {
    client.ws.send(JSON.stringify({ type: "session.history", threadId: "a", lazyReasoning: true }));
    await nextFrame(client);
    client.ws.send(JSON.stringify({ type: "session.sync", threadId: "a", lazyReasoning: true }));
    await nextFrame(client);
    client.ws.send(JSON.stringify({ type: "session.run.items", threadId: "a", fromId: "run-e1", untilId: "e9", lazyReasoning: true }));
    await nextFrame(client);
    assert.equal(store.historyCalls.at(-1)?.lazyReasoning, true);
    assert.equal(store.syncCalls.at(-1)?.lazyReasoning, true);
    assert.equal(store.runItemsCalls.at(-1)?.lazyReasoning, true);
  });

  test("chat.reasoning hands back what a bubble was sent without, and says so when it is gone", async () => {
    store.reasonings.set("p-1", "r".repeat(5000));
    client.ws.send(JSON.stringify({ type: "chat.reasoning", threadId: "a", id: "p-1" }));
    const frame = (await nextFrame(client)) as { type: string; threadId: string; id: string; reasoning: string; found: boolean };
    assert.deepEqual([frame.type, frame.threadId, frame.id, frame.found, frame.reasoning.length], ["chat.reasoning.result", "a", "p-1", true, 5000]);

    client.ws.send(JSON.stringify({ type: "chat.reasoning", threadId: "a", id: "p-gone" }));
    const gone = (await nextFrame(client)) as { type: string; found: boolean; reasoning: string };
    assert.deepEqual([gone.type, gone.found, gone.reasoning], ["chat.reasoning.result", false, ""]);
  });

  test("session.run.items hands back the work a folded row stood for", async () => {
    store.runRanges.set("run-e1..e9", [
      { id: "e1", role: "assistant", text: "etape", ts: "t1" },
      { id: "e9", role: "assistant", text: "fin", ts: "t2" },
    ]);
    client.ws.send(JSON.stringify({ type: "session.run.items", threadId: "a", fromId: "run-e1", untilId: "e9" }));
    const frame = (await nextFrame(client)) as { type: string; threadId: string; fromId: string; found: boolean; messages: unknown[] };
    assert.equal(frame.type, "chat.run.items");
    assert.equal(frame.threadId, "a");
    // Echoed in the form the client sent, because that is the row it has to replace.
    assert.equal(frame.fromId, "run-e1");
    assert.equal(frame.found, true);
    assert.equal(frame.messages.length, 2);
    assert.deepEqual(store.runItemsCalls.at(-1), { fromId: "run-e1", untilId: "e9" });
  });

  test("session.run.items says so when the branch no longer holds the range", async () => {
    // The group then stays collapsed and says it, rather than emptying itself in silence.
    client.ws.send(JSON.stringify({ type: "session.run.items", threadId: "a", fromId: "run-gone", untilId: "e9" }));
    const frame = (await nextFrame(client)) as { type: string; found: boolean; messages: unknown[] };
    assert.equal(frame.type, "chat.run.items");
    assert.equal(frame.found, false);
    assert.deepEqual(frame.messages, []);
  });

  test("session.run.items without a range is refused rather than guessed", async () => {
    client.ws.send(JSON.stringify({ type: "session.run.items", threadId: "a", fromId: "run-e1" }));
    const frame = (await nextFrame(client)) as { type: string; scope: string };
    assert.equal(frame.type, "error");
    assert.equal(frame.scope, "session");
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

  test("session.history says whether a run is in flight, both ways", async () => {
    // The app makes this page authoritative over its own run flag, which `session.list` seeds on a
    // separate round trip: a page that answered nothing let whichever reply landed first decide
    // what of the screen to keep, and the sealed bubbles of the turn in progress were the loss.
    const live = new Set<string>();
    adapter.onRunActive((sessionId) => live.has(sessionId));
    store.historyMap.set("a", [{ id: "h1", role: "user", text: "bonjour", ts: "t1" }]);

    client.ws.send(JSON.stringify({ type: "session.history", threadId: "a" }));
    let frame = (await nextFrame(client)) as { type: string; activeRun?: boolean };
    assert.equal(frame.type, "chat.history");
    assert.equal(frame.activeRun, false);

    live.add(store.resolveSessionId(DEVICE_ID, "a"));
    client.ws.send(JSON.stringify({ type: "session.history", threadId: "a" }));
    frame = (await nextFrame(client)) as { type: string; activeRun?: boolean };
    assert.equal(frame.type, "chat.history");
    assert.equal(frame.activeRun, true);
    // And the store reads its pages with the same authority: a run with no end and a card in
    // `running` are live only if this says so.
    assert.equal(store.runActive?.(store.resolveSessionId(DEVICE_ID, "a")), true);
    assert.equal(store.runActive?.("subagent/elsewhere"), false);
  });

  test("session.sync hands on the store's reading of the last run", async () => {
    // A run the server went down under: the delta has nothing in it, and this is what tells a
    // window that watched it live that it is over, and that it can be continued.
    store.historyMap.set("a", [{ id: "h1", role: "user", text: "bonjour", ts: "t1" }]);
    store.lastRun = { id: "r1", status: "interrupted", startTs: "t1", endTs: "t2" };
    client.ws.send(JSON.stringify({ type: "session.sync", threadId: "a", since: "h1" }));
    const frame = (await nextFrame(client)) as { type: string; lastRun?: { id: string; status: string } };
    assert.equal(frame.type, "session.sync.result");
    assert.deepEqual(frame.lastRun, store.lastRun);
  });

  test("session.history with an unsafe threadId returns an error frame", async () => {
    client.ws.send(JSON.stringify({ type: "session.history", threadId: "../x" }));
    const frame = (await nextFrame(client)) as { type: string };
    assert.equal(frame.type, "error");
  });

  test("session.archive files the thread away and replies with the refreshed listing", async () => {
    store.summaries = [
      { threadId: "a", title: "Infra", messageCount: 2, createdAt: "c", lastActiveAt: "l", lastMessageAt: "l" },
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
      { threadId: "a", title: "Infra", messageCount: 2, createdAt: "c", lastActiveAt: "l", lastMessageAt: "l", archived: true },
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

  test("folder.create names a folder, and every device of the owner is told", async () => {
    store.summaries = [
      { threadId: "a", title: "Infra", messageCount: 2, createdAt: "c", lastActiveAt: "l", lastMessageAt: "l" },
    ];
    // Two devices, one owner: a filing cabinet filed on one that the other cannot see is a cache.
    const other = await connectClient(adapter.port);

    client.ws.send(JSON.stringify({ type: "folder.create", name: "CubeFlow", workspace: "cf" }));
    const mine = (await nextFrame(client)) as { type: string; folders: Array<{ name: string; workspace?: string }> };
    assert.equal(mine.type, "session.list.result");
    assert.equal(mine.folders.length, 1);
    assert.equal(mine.folders[0]!.name, "CubeFlow");
    assert.equal(mine.folders[0]!.workspace, "cf");

    const theirs = (await nextFrame(other)) as { type: string; folders: unknown[] };
    assert.equal(theirs.type, "session.list.result");
    assert.equal(theirs.folders.length, 1);

    other.ws.close();
  });

  test("a folder name that is taken is refused with the reason, not with a shrug", async () => {
    client.ws.send(JSON.stringify({ type: "folder.create", name: "CubeFlow" }));
    await nextFrame(client);

    client.ws.send(JSON.stringify({ type: "folder.create", name: "cubeflow" }));
    const frame = (await nextFrame(client)) as { type: string; message: string };

    assert.equal(frame.type, "error");
    // The reason is the owner's to act on: a name he typed, not a scope that failed.
    assert.match(frame.message, /already exists/);
    assert.equal(store.folderList.length, 1);
  });

  test("session.folder files a conversation, and the listing says where it sits", async () => {
    store.summaries = [
      { threadId: "a", title: "Infra", messageCount: 2, createdAt: "c", lastActiveAt: "l", lastMessageAt: "l" },
    ];
    client.ws.send(JSON.stringify({ type: "folder.create", name: "CubeFlow" }));
    const created = (await nextFrame(client)) as { folders: Array<{ id: string }> };
    const folderId = created.folders[0]!.id;

    client.ws.send(JSON.stringify({ type: "session.folder", threadId: "a", folderId }));
    const listed = (await nextFrame(client)) as { sessions: Array<{ threadId: string; folderId?: string }> };

    assert.equal(listed.sessions[0]!.folderId, folderId);

    // And out of it again: null is a place the wire can name, unlike an absent field.
    client.ws.send(JSON.stringify({ type: "session.folder", threadId: "a", folderId: null }));
    const unfiled = (await nextFrame(client)) as { sessions: Array<{ folderId?: string }> };
    assert.equal(unfiled.sessions[0]!.folderId, undefined);
  });

  test("filing into a folder that does not exist is refused, not stored", async () => {
    store.summaries = [
      { threadId: "a", title: "Infra", messageCount: 2, createdAt: "c", lastActiveAt: "l", lastMessageAt: "l" },
    ];

    client.ws.send(JSON.stringify({ type: "session.folder", threadId: "a", folderId: "jamais-cree" }));
    const frame = (await nextFrame(client)) as { type: string; message: string };

    assert.equal(frame.type, "error");
    assert.match(frame.message, /folder not found/);
    assert.equal(store.summaries[0]!.folderId, undefined);
  });

  test("folder.remove unfiles what it held instead of losing it", async () => {
    store.summaries = [
      { threadId: "a", title: "Infra", messageCount: 2, createdAt: "c", lastActiveAt: "l", lastMessageAt: "l" },
      { threadId: "b", title: "Courses", messageCount: 1, createdAt: "c", lastActiveAt: "l", lastMessageAt: "l" },
    ];
    client.ws.send(JSON.stringify({ type: "folder.create", name: "CubeFlow" }));
    const created = (await nextFrame(client)) as { folders: Array<{ id: string }> };
    const folderId = created.folders[0]!.id;
    client.ws.send(JSON.stringify({ type: "session.folder", threadId: "a", folderId }));
    await nextFrame(client);
    client.ws.send(JSON.stringify({ type: "session.folder", threadId: "b", folderId }));
    await nextFrame(client);

    client.ws.send(JSON.stringify({ type: "folder.remove", folderId }));
    const after = (await nextFrame(client)) as { folders: unknown[]; sessions: Array<{ threadId: string; folderId?: string }> };

    assert.deepEqual(after.folders, []);
    // The conversations are still there, and no longer filed: deleting a folder never deletes one.
    assert.deepEqual(after.sessions.map((session) => session.threadId), ["a", "b"]);
    assert.equal(after.sessions[0]!.folderId, undefined);
    assert.equal(after.sessions[1]!.folderId, undefined);
  });

  test("session.delete removes the thread", async () => {
    client.ws.send(JSON.stringify({ type: "session.delete", threadId: "a" }));
    await nextFrame(client);
    assert.deepEqual(store.removed, ["a"]);
  });

  test("confirmTool sends approval.request and honours the grant the device chose", async () => {
    const approvalsAdapter = new MyClawAppAdapter(createConfig({ approvals: true }), store as never);
    approvalsAdapter.onMessage(() => Promise.resolve());
    await approvalsAdapter.start();
    const approvalClient = await connectClient(approvalsAdapter.port);

    const decisionPromise = approvalsAdapter.confirmTool(approvalRequest());
    const request = (await nextFrame(approvalClient)) as { type: string; id: string; toolName: string; args: Record<string, unknown>; allowSessionOffered: boolean };
    assert.equal(request.type, "approval.request");
    assert.equal(request.toolName, "bash");
    assert.deepEqual(request.args, { command: "ls" });
    // bash is per-invocation: a session grant is never offered for it.
    assert.equal(request.allowSessionOffered, false);

    approvalClient.ws.send(JSON.stringify({ type: "approval.response", id: request.id, decision: "allow-once" }));
    assert.equal(await decisionPromise, "allow-once");

    approvalClient.ws.close();
    await approvalsAdapter.stop();
  });

  // Approving one call used to whitelist the tool for the whole conversation, because the device
  // only sent `accepted: true` and the server read it as a session grant.
  test("a one-shot approval does not silently become a session grant", async () => {
    const approvalsAdapter = new MyClawAppAdapter(createConfig({ approvals: true }), store as never);
    approvalsAdapter.onMessage(() => Promise.resolve());
    await approvalsAdapter.start();
    const approvalClient = await connectClient(approvalsAdapter.port);

    const decisionPromise = approvalsAdapter.confirmTool({ ...approvalRequest(), toolName: "write" });
    const request = (await nextFrame(approvalClient)) as { id: string; allowSessionOffered: boolean };
    assert.equal(request.allowSessionOffered, true);

    approvalClient.ws.send(JSON.stringify({ type: "approval.response", id: request.id, decision: "allow-once" }));
    assert.equal(await decisionPromise, "allow-once");

    approvalClient.ws.close();
    await approvalsAdapter.stop();
  });

  // The offer is not made for bash, so a device claiming one is not to be trusted.
  test("a session grant asked for a per-invocation tool is downgraded, not obeyed", async () => {
    const approvalsAdapter = new MyClawAppAdapter(createConfig({ approvals: true }), store as never);
    approvalsAdapter.onMessage(() => Promise.resolve());
    await approvalsAdapter.start();
    const approvalClient = await connectClient(approvalsAdapter.port);

    const decisionPromise = approvalsAdapter.confirmTool(approvalRequest());
    const request = (await nextFrame(approvalClient)) as { id: string };
    approvalClient.ws.send(JSON.stringify({ type: "approval.response", id: request.id, decision: "allow-session" }));
    assert.equal(await decisionPromise, "allow-once");

    approvalClient.ws.close();
    await approvalsAdapter.stop();
  });

  test("a decision reaches the journal, and the history frame reads it back", async () => {
    const approvalsAdapter = new MyClawAppAdapter(createConfig({ approvals: true }), store as never);
    approvalsAdapter.onMessage(() => Promise.resolve());
    await approvalsAdapter.start();
    const approvalClient = await connectClient(approvalsAdapter.port);

    const decisionPromise = approvalsAdapter.confirmTool({ ...approvalRequest(), toolName: "write" });
    const request = (await nextFrame(approvalClient)) as { id: string };
    approvalClient.ws.send(JSON.stringify({ type: "approval.response", id: request.id, decision: "allow-session" }));
    await decisionPromise;
    // The resolved frame closes the sheet on the owner other windows.
    const resolved = (await nextFrame(approvalClient)) as { type: string; id: string };
    assert.equal(resolved.type, "approval.resolved");

    approvalClient.ws.send(JSON.stringify({ type: "approval.history" }));
    const history = (await nextFrame(approvalClient)) as {
      type: string;
      entries: Array<{ toolName: string; outcome: string; args: string }>;
      stats: { total: number; allowed: number; denied: number };
    };
    assert.equal(history.type, "approval.history.result");
    // Newest first, and earlier tests of this file share the journal: assert on this decision.
    assert.equal(history.entries[0]!.toolName, "write");
    assert.equal(history.entries[0]!.outcome, "allow-session");
    assert.equal(history.entries[0]!.args, JSON.stringify({ command: "ls" }));
    assert.ok(history.stats.allowed >= 1);

    approvalClient.ws.close();
    await approvalsAdapter.stop();
  });

  // An older app sends `accepted: true` and no decision. Reading that as a grant would run the
  // tool on an unreadable frame, so it is refused rather than guessed.
  test("an unreadable decision denies instead of guessing a grant", async () => {
    const approvalsAdapter = new MyClawAppAdapter(createConfig({ approvals: true }), store as never);
    approvalsAdapter.onMessage(() => Promise.resolve());
    await approvalsAdapter.start();
    const approvalClient = await connectClient(approvalsAdapter.port);

    const decisionPromise = approvalsAdapter.confirmTool({ ...approvalRequest(), toolName: "write" });
    const request = (await nextFrame(approvalClient)) as { id: string };
    approvalClient.ws.send(JSON.stringify({ type: "approval.response", id: request.id, accepted: true }));
    assert.equal(await decisionPromise, "deny");

    approvalClient.ws.close();
    await approvalsAdapter.stop();
  });

  test("a refusal is journalled as a refusal", async () => {
    const approvalsAdapter = new MyClawAppAdapter(createConfig({ approvals: true }), store as never);
    approvalsAdapter.onMessage(() => Promise.resolve());
    await approvalsAdapter.start();
    const approvalClient = await connectClient(approvalsAdapter.port);

    const decisionPromise = approvalsAdapter.confirmTool(approvalRequest());
    const request = (await nextFrame(approvalClient)) as { id: string };
    approvalClient.ws.send(JSON.stringify({ type: "approval.response", id: request.id, decision: "deny" }));
    assert.equal(await decisionPromise, "deny");
    await nextFrame(approvalClient);

    approvalClient.ws.send(JSON.stringify({ type: "approval.history" }));
    const history = (await nextFrame(approvalClient)) as { entries: Array<{ outcome: string }>; stats: { denied: number } };
    assert.equal(history.entries[0]!.outcome, "deny");
    assert.ok(history.stats.denied >= 1);

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
  test("chat.continue picks a stopped run back up with no bubble, and refuses a finished one", async () => {
    // docs/continue.md: the send pipeline with no text of its own; the run reads the log.
    const sessionId = store.resolveSessionId(DEVICE_ID, "default");
    const log = await sessionLogOf(sessionId);
    log.append<UserEntry>({ type: "user", prompt: true, text: "compte les fichiers" });
    log.append({ type: "run_start", prompt: false });
    log.append({ type: "phase", prompt: true, text: "", runId: "t1" });
    log.append({ type: "run_end", prompt: false, reason: "aborted" });
    await log.flush();

    client.ws.send(JSON.stringify({ type: "chat.continue", threadId: "default" }));
    await waitUntil(() => received.length === 1);
    const msg = received[0]!;
    assert.equal(msg.resume, true);
    assert.equal(msg.text, "compte les fichiers");
    assert.match(msg.id, /^continue-/);
    // No mirrored bubble: nobody typed anything.
    await assert.rejects(() => nextFrame(client, 200));

    log.append({ type: "run_start", prompt: false });
    log.append({ type: "phase", prompt: true, text: "57", runId: "t2" });
    log.append({ type: "run_end", prompt: false, reason: "done" });
    await log.flush();
    client.ws.send(JSON.stringify({ type: "chat.continue", threadId: "default" }));
    const refused = await nextFrame(client);
    assert.equal(refused.type, "chat.command.result");
    assert.match(String(refused.text), /Nothing to continue/);
    assert.equal(received.length, 1);

    const { end } = runRegistry.startRoot(sessionId);
    try {
      client.ws.send(JSON.stringify({ type: "chat.continue", threadId: "default" }));
      assert.match(String((await nextFrame(client)).text), /already going/);
    } finally {
      end();
    }
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

  test("two tabs of one device both stay connected and both get the answer", async () => {
    // A browser's device id comes from its session cookie, which belongs to the profile and not to
    // the tab: opening a second tab used to close the first, and the two then fought at one
    // reconnect per second forever.
    const first = await connectClient(adapter.port, "browser");
    const second = await connectClient(adapter.port, "browser");
    try {
      await adapter.send(OWNER, { text: "answered", threadId: "t-1" });

      assert.equal((await nextFrame(first))["text"], "answered");
      assert.equal((await nextFrame(second))["text"], "answered");
      assert.equal(first.closed, null, "the first tab must not be evicted by the second");
      assert.equal(second.closed, null);
    } finally {
      first.ws.close();
      second.ws.close();
    }
  });

  test("a draft typed in one tab reaches the other tab of the same device", async () => {
    const first = await connectClient(adapter.port, "browser");
    const second = await connectClient(adapter.port, "browser");
    try {
      first.ws.send(JSON.stringify({ type: "draft.set", threadId: "t-1", text: "commence dans cet onglet" }));

      const mirrored = await nextFrame(second);
      assert.equal(mirrored["type"], "draft.changed");
      assert.equal(mirrored["text"], "commence dans cet onglet");

      // Still not echoed to the tab that typed it: same rule, whatever the device.
      await adapter.send(OWNER, { text: "marker", threadId: "t-1" });
      assert.equal((await nextFrame(first))["type"], "chat.message");
    } finally {
      first.ws.close();
      second.ws.close();
    }
  });

  test("a draft typed on one device reaches the other, and never comes back to the sender", async () => {
    const phone = await connectClient(adapter.port, "phone");
    const browser = await connectClient(adapter.port, "browser");
    try {
      phone.ws.send(JSON.stringify({ type: "draft.set", threadId: "t-1", text: "un debut de" }));

      const mirrored = await nextFrame(browser);
      assert.equal(mirrored["type"], "draft.changed");
      assert.equal(mirrored["threadId"], "t-1");
      assert.equal(mirrored["text"], "un debut de");
      assert.equal(typeof mirrored["ts"], "number");

      // The sender already has its own text: an echo would be a frame whose only job is to be
      // ignored, and it would arrive as the owner keeps typing.
      await adapter.send(OWNER, { text: "marker", threadId: "t-1" });
      assert.equal((await nextFrame(phone))["type"], "chat.message");
    } finally {
      phone.ws.close();
      browser.ws.close();
    }
  });

  test("an unchanged draft is not re-broadcast", async () => {
    const phone = await connectClient(adapter.port, "phone");
    const browser = await connectClient(adapter.port, "browser");
    try {
      phone.ws.send(JSON.stringify({ type: "draft.set", threadId: "t-1", text: "stable" }));
      assert.equal((await nextFrame(browser))["type"], "draft.changed");

      // A reconnecting device re-sends what it holds. That is not news, and the other window is
      // possibly showing it in a composer the owner is looking at.
      phone.ws.send(JSON.stringify({ type: "draft.set", threadId: "t-1", text: "stable" }));
      await adapter.send(OWNER, { text: "marker", threadId: "t-1" });
      assert.equal((await nextFrame(browser))["type"], "chat.message");
    } finally {
      phone.ws.close();
      browser.ws.close();
    }
  });

  test("sending clears the draft and empties the other window's composer", async () => {
    const phone = await connectClient(adapter.port, "phone");
    const browser = await connectClient(adapter.port, "browser");
    try {
      phone.ws.send(JSON.stringify({ type: "draft.set", threadId: "t-1", text: "presque fini" }));
      assert.equal((await nextFrame(browser))["type"], "draft.changed");

      phone.ws.send(JSON.stringify({ type: "chat.send", id: "m1", text: "presque fini, voila", threadId: "t-1" }));

      const cleared = await nextFrame(browser);
      assert.equal(cleared["type"], "draft.changed");
      assert.equal(cleared["text"], "", "the message was sent: the mirrored composer must empty");
      assert.equal((await nextFrame(browser))["type"], "chat.user");
      assert.equal(store.drafts.size, 0);
    } finally {
      phone.ws.close();
      browser.ws.close();
    }
  });

  test("a draft on an unusable threadId is dropped in silence", async () => {
    const phone = await connectClient(adapter.port, "phone");
    const browser = await connectClient(adapter.port, "browser");
    try {
      phone.ws.send(JSON.stringify({ type: "draft.set", threadId: "../etc", text: "nope" }));

      // No error frame: a draft is not an action, and an error about unsent text would interrupt
      // the owner for nothing.
      await adapter.send(OWNER, { text: "marker", threadId: "t-1" });
      assert.equal((await nextFrame(browser))["type"], "chat.message");
      assert.equal(store.drafts.size, 0);
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

  // The boundary of a compaction, automatic or typed: every window of the owner draws the rule at
  // once, and it carries the entry id so a device that later reloads the thread has one, not two.
  test("a compaction boundary reaches every window of the owner", async () => {
    const phone = await connectClient(adapter.port, "phone");
    const browser = await connectClient(adapter.port, "browser");
    try {
      adapter.notifyCompaction(`my-claw-app/thread/${OWNER}/t-1`, { id: "e-42", summary: "ce qui precede", count: 813 });
      for (const window of [phone, browser]) {
        const boundary = await nextFrame(window);
        assert.equal(boundary["type"], "chat.compaction");
        assert.equal(boundary["threadId"], "t-1");
        assert.equal(boundary["id"], "e-42");
        assert.equal(boundary["summary"], "ce qui precede");
        assert.equal(boundary["count"], 813);
      }
    } finally {
      phone.ws.close();
      browser.ws.close();
    }
  });

  /**
   * The summary being written, live, and handed whole to a window that arrives mid-compaction.
   *
   * Added 2026-09-12: the summarizer streams, so the operation can show its text instead of a
   * bare counter. The live fragments are appended by the client; the replayed frame has to carry
   * everything written so far, or a reload would show the operation with none of its words.
   */
  test("the summary streams to the windows watching, and a late one is handed what was written", async () => {
    const phone = await connectClient(adapter.port, "phone");
    try {
      adapter.notifyCompacting(`my-claw-app/thread/${OWNER}/t-1`, Date.now());
      assert.equal((await nextFrame(phone))["type"], "chat.compacting");

      adapter.notifyCompactionProgress(`my-claw-app/thread/${OWNER}/t-1`, "Prior work: ");
      const first = await nextFrame(phone);
      assert.equal(first["type"], "chat.compacting.delta");
      assert.equal(first["threadId"], "t-1");
      assert.equal(first["text"], "Prior work: ");

      adapter.notifyCompactionProgress(`my-claw-app/thread/${OWNER}/t-1`, "we fixed the runner.");
      const second = await nextFrame(phone);
      assert.equal(second["type"], "chat.compacting.delta");
      assert.equal(second["text"], "we fixed the runner.");

      // A window that opens now gets the operation, once, with the whole text so far.
      const late = await connectClient(adapter.port, "browser");
      late.ws.send(JSON.stringify({ type: "session.sync", threadId: "t-1" }));
      const page = await nextFrame(late);
      assert.equal(page["type"], "session.sync.result");
      assert.equal((page["compacting"] as { text?: string }).text, "Prior work: we fixed the runner.");
      late.ws.close();
    } finally {
      phone.ws.close();
    }
  });

  /**
   * The operation is minutes of silence with nothing on the wire. The window that typed
   * `/compact` had a placeholder; every other one, and that same one after a reload, saw a thread
   * doing nothing -- so the owner typed `/compact` again and was told one was already running.
   */
  test("a compaction in flight reaches every window, and the one that arrives after it started", async () => {
    const phone = await connectClient(adapter.port, "phone");
    try {
      const started = Date.now() - 42_000;
      adapter.notifyCompacting(`my-claw-app/thread/${OWNER}/t-1`, started);
      const live = await nextFrame(phone);
      assert.equal(live["type"], "chat.compacting");
      assert.equal(live["threadId"], "t-1");
      // The instant it began, not an elapsed: a late window counts from the same zero.
      assert.equal(live["since"], new Date(started).toISOString());

      const late = await connectClient(adapter.port, "browser");
      late.ws.send(JSON.stringify({ type: "session.sync", threadId: "t-1" }));
      const page = await nextFrame(late);
      assert.equal(page["type"], "session.sync.result");
      // The instant it began, not an elapsed: a late window counts from the same zero.
      assert.deepEqual(page["compacting"], { since: new Date(started).toISOString() });

      adapter.notifyCompacting(`my-claw-app/thread/${OWNER}/t-1`, undefined);
      const over = await nextFrame(phone);
      assert.equal(over["type"], "chat.compacting");
      assert.equal(over["since"], undefined, "no start means it is over");

      // And a window opening now is not shown an operation that has stopped -- and is told so.
      const after = await connectClient(adapter.port, "browser");
      after.ws.send(JSON.stringify({ type: "session.sync", threadId: "t-1" }));
      const settled = await nextFrame(after);
      assert.equal(settled["type"], "session.sync.result");
      assert.equal(settled["compacting"], undefined, "the sync says: not compacting");
      await assert.rejects(() => nextFrame(after, 300));
      late.ws.close();
      after.ws.close();
    } finally {
      phone.ws.close();
    }
  });

  /**
   * A window that missed the end of a compaction is told, not left to guess.
   *
   * Measured on the owner's phone, 2026-09-13: a `/compact` that had succeeded kept its rule on
   * screen for another nineteen minutes, counter still climbing from the instant it started, and
   * `/stop` -- answering truthfully that nothing was running -- read as the server losing the
   * plot. The end is broadcast once, to the windows that are connected at that second. Nothing was
   * ever done about the ones that were not: the socket drops every ten to forty minutes on that
   * device, and a frame lost while the thread is quiet had nothing to correct it.
   */
  test("a window that missed the end of a compaction is told it is over", async () => {
    const phone = await connectClient(adapter.port, "phone");
    try {
      const started = Date.now() - 12_000;
      adapter.notifyCompacting(`my-claw-app/thread/${OWNER}/t-1`, started);
      assert.equal((await nextFrame(phone))["type"], "chat.compacting");

      // The end lands on the phone above, and nowhere else: this window is the one the socket
      // dropped for, and the rule it already drew has no way back down on its own.
      adapter.notifyCompacting(`my-claw-app/thread/${OWNER}/t-1`, undefined);
      await nextFrame(phone);

      const missed = await connectClient(adapter.port, "browser");
      missed.ws.send(JSON.stringify({ type: "session.sync", threadId: "t-1" }));
      const state = await nextFrame(missed);
      assert.equal(state["type"], "session.sync.result");
      assert.equal(state["threadId"], "t-1");
      assert.equal(state["compacting"], undefined, "the sync says: not compacting");

      // And the state is said every time, not once: a window that reconnects later is corrected
      // just the same, since the interesting case is precisely the one with no event to carry it.
      missed.ws.send(JSON.stringify({ type: "session.sync", threadId: "t-1" }));
      const again = await nextFrame(missed);
      assert.equal(again["type"], "session.sync.result");
      assert.equal(again["compacting"], undefined);
      missed.ws.close();
    } finally {
      phone.ws.close();
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
    store.summaries = [{ threadId: "projet", title: "salut", messageCount: 2, createdAt: "c", lastActiveAt: "l", lastMessageAt: "l" }];
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
      list: () => ({ tools: [{ name: "bash", description: "Run", source: "built-in", disabled: false, confirm: false }], missing: [] }),
      toggle: async (name, disabled) => ({ tools: [{ name, description: "Run", source: "built-in", disabled, confirm: false }], missing: [] }),
      confirm: async (name, confirm) => ({ tools: [{ name, description: "Run", source: "built-in", disabled: false, confirm }], missing: [] }),
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

  test("pushModelList broadcasts the catalog to every socket of the owner, unasked", async () => {
    // The app holds its own copy of the catalogue; a login re-discovers the provider and the
    // server-side picker moves, but the device only learns about it when it asks again. The push
    // is what makes the new models appear without a manual refresh.
    adapter.pushModelList(DEVICE_ID);
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

  test("a timeout of zero survives the round trip instead of reading as unset", async () => {
    // `0` is the declaration that removes the server's wall, so any truthiness check between the
    // form and the config file silently puts the transport default back.
    store = new FakeSessionStore();
    const editable = new MyClawAppAdapter(createConfig(), store as never);
    const written: Array<Record<string, unknown>> = [];
    const declared: Array<{ id: string; label: string; timeoutMs?: number }> = [{ id: "fast-1", label: "Fast" }];
    editable.onModelController({
      list: () => ({ models: declared, defaultModel: "fast-1", unavailable: [] }),
      endpoints: async () => [],
      current: async () => ({ model: "fast-1", defaultModel: "fast-1", effort: { level: "", levels: [], supported: false }, context: { raw: 200000, effective: 200000 } }),
      set: async () => ({ model: "fast-1", defaultModel: "fast-1", effort: { level: "", levels: [], supported: false }, context: { raw: 200000, effective: 200000 } }),
      setEffort: async () => ({ model: "fast-1", defaultModel: "fast-1", effort: { level: "", levels: [], supported: false }, context: { raw: 200000, effective: 200000 } }),
      setContext: async () => ({ model: "fast-1", defaultModel: "fast-1", effort: { level: "", levels: [], supported: false }, context: { raw: 200000, effective: 200000 } }),
      upsert: async (entry) => {
        written.push(entry as unknown as Record<string, unknown>);
        declared.push({ id: entry.id, label: entry.label ?? entry.id, ...(entry.timeoutMs === undefined ? {} : { timeoutMs: entry.timeoutMs }) });
      },
    });
    await editable.start();
    try {
      const c = await connectClient(editable.port);
      c.ws.send(JSON.stringify({ type: "models.upsert", id: "litellm/local", provider: "litellm", timeoutMs: 0 }));
      const frame = await nextFrame(c);
      assert.equal(frame["type"], "model.list.result");
      assert.equal(written[0]!["timeoutMs"], 0);
      const listed = (frame["models"] as Array<{ id: string; timeoutMs?: number }>).find((m) => m.id === "litellm/local");
      assert.equal(listed?.timeoutMs, 0);
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
    retry: { enabled: true, delaysMs: [30_000, 60_000, 120_000] },
    contextCap: { default: 512_000 },
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
      setRetry: async (patch) => ({ ...SNAPSHOT, retry: { enabled: patch.enabled, delaysMs: patch.delaysMs ?? SNAPSHOT.retry.delaysMs } }),
      setDefaultContextCap: async (value) => ({ ...SNAPSHOT, contextCap: { ...(value === null ? {} : { value }), default: 512_000 } }),
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

  test("agents.defaultcap.set writes the global ceiling, and null hands it back to the default", async () => {
    client.ws.send(JSON.stringify({ type: "agents.defaultcap.set", value: 256_000 }));
    let frame = await nextFrame(client);
    assert.equal(frame["type"], "agents.config.result");
    assert.deepEqual(frame["contextCap"], { value: 256_000, default: 512_000 });

    // 0 is a value, not an absence: it is how the ceiling is lifted.
    client.ws.send(JSON.stringify({ type: "agents.defaultcap.set", value: 0 }));
    frame = await nextFrame(client);
    assert.deepEqual(frame["contextCap"], { value: 0, default: 512_000 });

    client.ws.send(JSON.stringify({ type: "agents.defaultcap.set", value: null }));
    frame = await nextFrame(client);
    assert.deepEqual(frame["contextCap"], { default: 512_000 });
  });

  test("agents.defaultcap.set refuses what is not a token count, before anything is written", async () => {
    for (const value of [-1, 1.5, "512000"]) {
      client.ws.send(JSON.stringify({ type: "agents.defaultcap.set", value }));
      const frame = await nextFrame(client);
      assert.equal(frame["type"], "error");
      assert.equal(frame["scope"], "agents");
    }
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
      setRetry: async () => SNAPSHOT,
      setDefaultContextCap: async () => SNAPSHOT,
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
      setRetry: async () => {
        throw new Error("nope");
      },
      setDefaultContextCap: async () => {
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
    { name: "read", description: "Read a file", source: "built-in", disabled: false, confirm: false },
    { name: "bash", description: "Run a command", source: "built-in", disabled: true, confirm: false },
    { name: "my_weather", description: "Forecast for a city", source: "plugin", disabled: false, confirm: false },
    { name: "mcp__mailcow__get_status", description: "Mail server status", source: "mcp", server: "mailcow", disabled: false, confirm: false },
    { name: "mcp__mailcow__send_mail", description: "Send a mail", source: "mcp", server: "mailcow", disabled: false, confirm: false },
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
      confirm: async (name, confirm) => ({
        tools: TOOLS.map((t) => (t.name === name ? { ...t, confirm } : t)),
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
    assert.deepEqual(tools[0], { name: "read", description: "Read a file", source: "built-in", disabled: false, confirm: false });
    assert.deepEqual(tools[1], { name: "bash", description: "Run a command", source: "built-in", disabled: true, confirm: false });
    assert.deepEqual(tools[2], { name: "my_weather", description: "Forecast for a city", source: "plugin", disabled: false, confirm: false });
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

  test("tools.confirm forwards name and confirm and answers with the fresh catalog", async () => {
    client.ws.send(JSON.stringify({ type: "tools.confirm", name: "bash", confirm: true }));
    const frame = await nextFrame(client);
    assert.equal(frame["type"], "tools.list.result");
    const bash = (frame["tools"] as Array<Record<string, unknown>>).find((t) => t["name"] === "bash");
    assert.equal(bash?.["confirm"], true);
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
      confirm: async () => {
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
          { workspace: "default", file: "AGENTS.md", origin: "own", from: "default", bytes: 12, sha: "abc123abc123", inherit: "default", off: false, empty: false, template: false },
          { workspace: "sofa", file: "AGENTS.md", origin: "inherited", from: "default", bytes: 12, sha: "abc123abc123", inherit: "default", off: false, empty: false, template: false },
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
          { workspace, file, origin: "own", from: workspace, bytes: 12, sha: "abc123abc123", inherit: inherit ?? "default", off: off ?? false, empty: off ?? false, template: false },
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
    // The mock stands in for the registry: its answer is the cycle's first stop, which is the
    // only outcome these command-frame tests need. The silence of a second stop is proven
    // against the real registry, in its own test below.
    adapter.onStop(() => "stopped");
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
    assert.deepEqual(store.journal, [{ threadId: "t1", input: "/compact", output: "compact done", sourceId: "j1" }]);
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

  test("/new is a quiet command and tells the app which thread to open", async () => {
    adapter.onCommandHandler(async (_owner, _threadId, command, args) => {
      handled.push({ command, args });
      return command === "new" ? { text: "New session started.", newThreadId: "new-thread" } : `${command} done`;
    });
    client.ws.send(JSON.stringify({ type: "chat.send", id: "j4", text: "/new", threadId: "t1" }));
    const frame = await nextFrame(client);
    assert.equal(frame["type"], "chat.command.result");
    assert.equal(frame["text"], "New session started.");
    assert.equal(frame["newThreadId"], "new-thread");
    assert.equal(frame["dropInput"], true);
    assert.equal((await nextFrame(client))["type"], "session.list.result");
    assert.deepEqual(handled, [{ command: "new", args: "" }]);
  });

  test("a retried command id cannot run /new twice", async () => {
    let newCalls = 0;
    let finishNew!: () => void;
    const firstNew = new Promise<void>((resolve) => {
      finishNew = resolve;
    });
    adapter.onCommandHandler(async (_owner, _threadId, command) => {
      if (command === "new") {
        newCalls += 1;
        await firstNew;
        return { text: "New session started.", newThreadId: `new-thread-${newCalls}` };
      }
      return `${command} done`;
    });

    client.ws.send(JSON.stringify({ type: "chat.send", id: "retry-new", text: "/new", threadId: "t1" }));
    await waitUntil(() => newCalls === 1);
    const retry = await connectClient(adapter.port, DEVICE_ID, TOKEN, false, false, false, false, true);
    try {
      retry.ws.send(JSON.stringify({ type: "chat.send", id: "retry-new", text: "/new", threadId: "t1" }));
      assert.deepEqual(await nextFrame(retry), { type: "chat.send.received", threadId: "t1", id: "retry-new" });
      finishNew();

      const result = await nextFrame(client);
      assert.equal(result["newThreadId"], "new-thread-1");
      assert.equal((await nextFrame(client))["type"], "session.list.result");
      client.ws.send(JSON.stringify({ type: "chat.send", id: "after-retry", text: "/status", threadId: "t1" }));
      await nextFrame(client);
      assert.equal(newCalls, 1);
    } finally {
      retry.ws.close();
    }
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
      createdAt: "2026-08-08T10:00:00.000Z",
      lastActiveAt: "2026-08-08T11:00:00.000Z", lastMessageAt: "2026-08-08T11:00:00.000Z",
      turns: 2,
    },
    model: {
      current: "claude-opus-5",
      defaultModel: "claude-opus-5",
      effort: "high",
      effortSource: "config" as const,
      selfHosted: false,
      contextLimit: 512_000,
      contextNotes: ["declared", "capped from 1,000,000"],
      timeout: "600s (default)",
    },
    context: {
      measured: { tokens: 12_345, pctOfLimit: 2.4 },
      estimated: 60_000,
      occupied: 70_000,
      autoCompactOn: true,
      autoCompactThresholdPct: 80,
      autoCompactThresholdTokens: 409_600,
    },
    usage: {
      total: { calls: 4, errors: 0, promptTokens: 1000, cacheReadTokens: 0, completionTokens: 100, billedUsd: 2.0, referenceUsd: 0, unpriced: 0 },
      own: {
        calls: 4,
        errors: 0,
        promptTokens: 1000,
        cacheReadTokens: 0,
        completionTokens: 100,
        billedUsd: 2.0,
        referenceUsd: 0,
        unpriced: 0,
        durationMs: 4000,
        rows: [
          {
            model: "claude-opus-5",
            providerKey: "anthropic",
            providerLabel: "Claude",
            provider: "api.anthropic.com",
            calls: 4,
            errors: 0,
            promptTokens: 1000,
            cacheReadTokens: 0,
            completionTokens: 100,
            costUsd: 2.0,
            costBilled: true,
            costApproximate: false,
          },
        ],
      },
      agents: [],
    },
    runtime: { runs: [], compacting: false, verbose: true, approvedTools: ["bash"] },
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

  test("status.watch answers the report now, then again when the conversation moves, until unwatch", async () => {
    const agent = new MyClawAppAdapter(createConfig(), store as never);
    let reports = 0;
    agent.onCommandHandler(async (_owner, threadId) => {
      reports += 1;
      return { text: `status of ${threadId}`, status: { ...STATUS_PAYLOAD, session: { ...STATUS_PAYLOAD.session, turns: reports } } };
    });
    await agent.start();
    const client2 = await connectClient(agent.port);
    client2.ws.send(JSON.stringify({ type: "status.watch", threadId: "t9" }));
    const first = await nextFrame(client2);
    assert.equal(first["type"], "status.result");
    assert.equal(first["threadId"], "t9");
    assert.equal((first["status"] as { session: { turns: number } }).session.turns, 1);
    assert.equal("text" in first, false, "the page carries the report, the text belongs to the chat command alone");

    // A call recorded on the conversation's session: the page is pushed a fresh report, unasked.
    agent.statusChanged(store.resolveSessionId(DEVICE_ID, "t9"));
    const pushed = await nextFrame(client2);
    assert.equal(pushed["type"], "status.result");
    assert.equal((pushed["status"] as { session: { turns: number } }).session.turns, 2);

    // A sub-agent billed to this conversation moves the parent's page too.
    store.payers.set("subagent/digger-1", store.resolveSessionId(DEVICE_ID, "t9"));
    agent.statusChanged("subagent/digger-1");
    const delegated = await nextFrame(client2);
    assert.equal((delegated["status"] as { session: { turns: number } }).session.turns, 3);

    // Another conversation is not this page's business.
    agent.statusChanged(store.resolveSessionId(DEVICE_ID, "elsewhere"));
    // And once the page is closed, nothing arrives at all.
    client2.ws.send(JSON.stringify({ type: "status.unwatch" }));
    await new Promise((r) => setTimeout(r, 50));
    agent.statusChanged(store.resolveSessionId(DEVICE_ID, "t9"));
    await assert.rejects(nextFrame(client2, 500), "an unwatched page receives nothing");
    client2.ws.close();
    await agent.stop();
  });

  test("status.watch for a thread id that cannot land in a file path is refused", async () => {
    client.ws.send(JSON.stringify({ type: "status.watch", threadId: "bad/id!" }));
    const frame = await nextFrame(client);
    assert.equal(frame["type"], "error");
    assert.equal(frame["scope"], "status");
  });

  const STATS_PAYLOAD = {
    period: "30d" as const,
    rollupIncluded: false,
    totals: { calls: 3, errors: 0, promptTokens: 10, completionTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, billedUsd: 1, referenceUsd: 0, unpriced: 0, durationMs: 5 },
    models: [],
    providerKeys: [],
    providers: [],
    sessions: [],
    daily: [],
    reliability: [],
    cache: { promptTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, readSharePct: 0, writeSharePct: 0 },
    callers: [],
    reconciliation: [],
    filter: {},
    facets: { models: [], providers: [], providerLabels: {}, callers: [], sessions: [], workspaces: [], folders: [] },
  };

  test("stats.get answers the install-wide report for the period it names, and nothing per thread", async () => {
    const agent = new MyClawAppAdapter(createConfig(), store as never);
    const asked: string[] = [];
    agent.onStatsController({
      report: async (period) => {
        asked.push(period);
        return { ...STATS_PAYLOAD, period };
      },
    });
    await agent.start();
    const client2 = await connectClient(agent.port);
    client2.ws.send(JSON.stringify({ type: "stats.get", period: "all" }));
    const frame = await nextFrame(client2);
    assert.equal(frame["type"], "stats.result");
    assert.deepEqual(asked, ["all"]);
    assert.equal((frame["stats"] as { period: string }).period, "all");
    assert.equal("threadId" in frame, false, "the page is about the install, not about a conversation");
    client2.ws.close();
    await agent.stop();
  });

  test("a period the server does not offer is refused, never silently narrowed to one it does", async () => {
    const agent = new MyClawAppAdapter(createConfig(), store as never);
    let called = 0;
    agent.onStatsController({
      report: async (period) => {
        called += 1;
        return { ...STATS_PAYLOAD, period };
      },
    });
    await agent.start();
    const client2 = await connectClient(agent.port);
    client2.ws.send(JSON.stringify({ type: "stats.get", period: "6mo" }));
    const frame = await nextFrame(client2);
    assert.equal(frame["type"], "error");
    assert.equal(frame["scope"], "stats");
    assert.equal(called, 0, "a window that asked for six months must not be handed another period and believe it");
    client2.ws.close();
    await agent.stop();
  });

  test("the filter of a stats.get reaches the report, and comes back echoed", async () => {
    const agent = new MyClawAppAdapter(createConfig(), store as never);
    const seen: unknown[] = [];
    agent.onStatsController({
      report: async (period, filter) => {
        seen.push(filter);
        return { ...STATS_PAYLOAD, period, filter };
      },
    });
    await agent.start();
    const client2 = await connectClient(agent.port);
    client2.ws.send(JSON.stringify({ type: "stats.get", period: "30d", filter: { model: "glm-5.2", errorsOnly: true } }));
    const frame = await nextFrame(client2);
    assert.equal(frame["type"], "stats.result");
    assert.deepEqual(seen, [{ model: "glm-5.2", errorsOnly: true }]);
    assert.deepEqual((frame["stats"] as { filter: unknown }).filter, { model: "glm-5.2", errorsOnly: true });
    client2.ws.close();
    await agent.stop();
  });

  test("a stats.get with no filter asks the report for the whole window, not for nothing", async () => {
    const agent = new MyClawAppAdapter(createConfig(), store as never);
    const seen: unknown[] = [];
    agent.onStatsController({
      report: async (period, filter) => {
        seen.push(filter);
        return { ...STATS_PAYLOAD, period, filter };
      },
    });
    await agent.start();
    const client2 = await connectClient(agent.port);
    client2.ws.send(JSON.stringify({ type: "stats.get", period: "7d" }));
    await nextFrame(client2);
    assert.deepEqual(seen, [{}]);
    client2.ws.close();
    await agent.stop();
  });

  test("a filter that is not one is refused, never coerced into a report of something else", async () => {
    const agent = new MyClawAppAdapter(createConfig(), store as never);
    let called = 0;
    agent.onStatsController({
      report: async (period) => {
        called += 1;
        return { ...STATS_PAYLOAD, period };
      },
    });
    await agent.start();
    const client2 = await connectClient(agent.port);
    for (const filter of [{ model: 42 }, { nosuchthing: "x" }, { errorsOnly: "yes" }, [], "model"]) {
      client2.ws.send(JSON.stringify({ type: "stats.get", period: "30d", filter }));
      const frame = await nextFrame(client2);
      assert.equal(frame["type"], "error", `filter ${JSON.stringify(filter)} must be refused`);
      assert.equal(frame["scope"], "stats");
    }
    assert.equal(called, 0, "an unreadable filter must not be answered with an unfiltered report");
    client2.ws.close();
    await agent.stop();
  });

  test("stats.get with no controller wired is refused rather than answered with an empty page", async () => {
    client.ws.send(JSON.stringify({ type: "stats.get", period: "7d" }));
    const frame = await nextFrame(client);
    assert.equal(frame["type"], "error");
    assert.equal(frame["scope"], "stats");
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
        layersOff: [],
        skillsOff: [],
        skills: [],
        memoryRecallOff: false,
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

  test("session.instructions.set applies the control and answers the fresh report", async () => {
    const agent = new MyClawAppAdapter(createConfig(), store as never);
    agent.onSessionInstructions(async () => ({
      agent: "orchestrator",
      workspace: "default",
      workspaceDir: "/ws",
      model: "m",
      backend: "openai",
      platform: "my-claw-app",
      totalBytes: 3,
      layers: [{ id: "CORE", label: "Core directives", bytes: 3, text: "abc" }],
      nested: [],
      layersOff: [],
      skillsOff: [],
      skills: [],
      memoryRecallOff: false,
      notes: [],
    }));
    await agent.start();
    const client2 = await connectClient(agent.port);
    client2.ws.send(JSON.stringify({ type: "session.instructions.set", threadId: "t9", patch: { kind: "nested.toggle", path: "/repo/AGENTS.md" } }));
    const frame = await nextFrame(client2);
    assert.equal(frame["type"], "session.instructions.result");
    assert.equal(frame["threadId"], "t9");
    assert.deepEqual(store.patches, [{ threadId: "t9", patch: { kind: "nested.toggle", path: "/repo/AGENTS.md" } }]);
    client2.ws.close();
    await agent.stop();
  });

  test("status.watch without a command handler is refused where the page asked", async () => {
    const agent = new MyClawAppAdapter(createConfig(), store as never);
    await agent.start();
    const client2 = await connectClient(agent.port);
    client2.ws.send(JSON.stringify({ type: "status.watch", threadId: "t9" }));
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
    // The stop is said to every window of the owner the moment the claim is taken -- the stub
    // answers "stopped", so the frame is the claim's own, emitted once.
    const stopping = await nextFrame(client);
    assert.equal(stopping["type"], "chat.run.stopping");
    assert.equal(stopping["threadId"], "t9");
    const frame = await nextFrame(client);
    assert.equal(frame["type"], "chat.command.result");
  });

  /**
   * One stop per cycle, at the surface the owner actually presses: while the abort is in flight,
   * a second chat.stop must draw nothing -- no frame, no text. Three presses used to draw three
   * "Stopped." bubbles for one abort. Wired to the real registry, so the silence proven here is
   * the production one, not a mock's.
   */
  test("a second chat.stop while the abort is in flight draws no frame at all", async () => {
    adapter.onStop((sessionId) => runRegistry.stop(sessionId));
    const sessionId = store.resolveSessionId(DEVICE_ID, "t-one-stop");
    const { end } = runRegistry.startRoot(sessionId);
    try {
      client.ws.send(JSON.stringify({ type: "chat.stop", threadId: "t-one-stop" }));
      const first = await nextFrame(client);
      assert.equal(first["type"], "chat.run.stopping");
      assert.equal(first["threadId"], "t-one-stop");
      const answer = await nextFrame(client);
      assert.equal(answer["type"], "chat.command.result");
      assert.equal(answer["text"], "Stopped.");

      client.ws.send(JSON.stringify({ type: "chat.stop", threadId: "t-one-stop" }));
      await new Promise((r) => setTimeout(r, 150));
      assert.equal(client.frames.length, 0, "the second stop must not produce a frame");

      // The cycle over, the next press finds nothing -- and says so, once, in its own words.
      end();
      client.ws.send(JSON.stringify({ type: "chat.stop", threadId: "t-one-stop" }));
      const idle = await nextFrame(client);
      assert.equal(idle["type"], "chat.command.result");
      assert.equal(idle["text"], "Nothing running.");
      // And an idle stop says nothing about a stop: no frame, nothing held for a reload.
      await new Promise((r) => setTimeout(r, 150));
      assert.equal(client.frames.length, 0, "an idle stop must not announce one");
    } finally {
      end();
      runRegistry.clear();
    }
  });

  test("session.clear is gone: emptying a conversation is not offered anymore", async () => {
    client.ws.send(JSON.stringify({ type: "session.clear", threadId: "t5" }));
    // Unknown frames are ignored, so prove it by getting an answer to the next one instead.
    client.ws.send(JSON.stringify({ type: "session.list" }));
    const frame = await nextFrame(client);
    assert.equal(frame["type"], "session.list.result");
  });

  test("/new with arguments remains a normal message", async () => {
    const received: string[] = [];
    adapter.onMessage(async (message) => {
      received.push(message.text);
    });
    const text = "/new doit etre supprime, on a plus matrix et telegram";
    client.ws.send(JSON.stringify({ type: "chat.send", id: "c4", text, threadId: "t8" }));
    await waitUntil(() => received.length === 1);
    assert.deepEqual(received, [text]);
    assert.deepEqual(handled, [], "the command handler was never consulted");
    assert.ok(
      client.frames.every((f) => !["chat.command.result", "chat.cleared"].includes(String((f as Record<string, unknown>)["type"]))),
      "a sentence about /new must not navigate or clear a thread",
    );
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

  test("GET /app-update answers the paired device with the latest release", async () => {
    process.env["MY_CLAW_RELEASE_URL"] = "https://dl.example.test/my-claw";
    process.env["MY_CLAW_RELEASE_KEY"] = "dlh_secret";
    resetAppUpdateCache();
    // The mock must only swallow the release source's call. The test's own request to the local adapter
    // would otherwise be answered by the mock with a release list.
    const realFetch = globalThis.fetch.bind(globalThis);
    const fetchMock = mockFetch(async (input, init) => {
      const url = String(input);
      if (url.startsWith("http://127.0.0.1")) return realFetch(input as string, init);
      return Response.json({
        version: "0.5.55",
        publishedAt: "2026-08-30T12:00:00Z",
        files: [{ name: "my-claw-app-v0.5.55.apk", size: 45438191 }],
      });
    });
    try {
      const res = await fetch(`http://127.0.0.1:${adapter.port}/app-update?device=${DEVICE_ID}&token=${TOKEN}`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { ok: boolean; version?: string };
      assert.equal(body.ok, true);
      assert.equal(body.version, "0.5.55");
    } finally {
      fetchMock.restore();
      delete process.env["MY_CLAW_RELEASE_URL"];
      delete process.env["MY_CLAW_RELEASE_KEY"];
      resetAppUpdateCache();
    }
  });

  test("GET /app-update refuses unpaired devices", async () => {
    const res = await fetch(`http://127.0.0.1:${adapter.port}/app-update?device=unknown-device&token=${TOKEN}`);
    assert.equal(res.status, 401);
  });

  test("GET /app-update/apk streams the apk to the paired device", async () => {
    process.env["MY_CLAW_RELEASE_URL"] = "https://dl.example.test/my-claw";
    process.env["MY_CLAW_RELEASE_KEY"] = "dlh_secret";
    resetAppUpdateCache();
    const realFetch = globalThis.fetch.bind(globalThis);
    const fetchMock = mockFetch(async (input, init) => {
      const url = String(input);
      if (url.startsWith("http://127.0.0.1")) return realFetch(input as string, init);
      if (url.endsWith("/app/latest.json")) {
        return Response.json({ version: "0.5.55", files: [{ name: "my-claw-app-v0.5.55.apk", size: 11 }] });
      }
      return new Response("PK\x03\x04fake-apk", { status: 200 });
    });
    try {
      const res = await fetch(`http://127.0.0.1:${adapter.port}/app-update/apk?device=${DEVICE_ID}&token=${TOKEN}`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-type"), "application/vnd.android.package-archive");
    } finally {
      fetchMock.restore();
      delete process.env["MY_CLAW_RELEASE_URL"];
      delete process.env["MY_CLAW_RELEASE_KEY"];
      resetAppUpdateCache();
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
        subagents: job.subagents !== false,
        browser: job.browser !== false,
        followUp: job.followUp === true,
        ...(job.followUpPrompt ? { followUpPrompt: job.followUpPrompt } : {}),
        nextRunAt: job.nextRunAt,
        lastRunAt: job.lastRunAt,
        lastStatus: job.lastStatus === "interrupted" ? "error" : job.lastStatus,
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
          ...(fields.subagents === undefined ? {} : { subagents: fields.subagents === true }),
          ...(fields.browser === undefined ? {} : { browser: fields.browser === true }),
          ...(fields.followUp === undefined ? {} : { followUp: fields.followUp === true }),
          ...(fields.followUpPrompt === undefined ? {} : { followUpPrompt: fields.followUpPrompt }),
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

  test("the capability switches ride on jobs.save, are stored as a denial, and clear back", async () => {
    client.ws.send(JSON.stringify({
      type: "jobs.save",
      name: "Watcher",
      prompt: "watch it",
      schedule: "every 1h",
      enabled: true,
      skills: { mode: "inherit" },
      mcp: { mode: "inherit" },
      tools: { mode: "inherit" },
      subagents: false,
      browser: false,
    }));
    const deniedFrame = await nextFrame(client);
    assert.equal(deniedFrame["type"], "jobs.list.result");
    const denied = (deniedFrame["jobs"] as Array<Record<string, unknown>>)[0]!;
    assert.equal(denied["subagents"], false);
    assert.equal(denied["browser"], false);
    // Stored as the denial only: granted is the default, so granting leaves no trace.
    assert.equal(jobs[0]!["subagents"], false);
    assert.equal(jobs[0]!["browser"], false);

    client.ws.send(JSON.stringify({
      type: "jobs.save",
      id: jobs[0]!["id"],
      name: "Watcher",
      prompt: "watch it",
      schedule: "every 1h",
      enabled: true,
      skills: { mode: "inherit" },
      mcp: { mode: "inherit" },
      tools: { mode: "inherit" },
      subagents: true,
      browser: true,
    }));
    const grantedFrame = await nextFrame(client);
    const granted = (grantedFrame["jobs"] as Array<Record<string, unknown>>)[0]!;
    assert.equal(granted["subagents"], true);
    assert.equal(granted["browser"], true);
    assert.equal(jobs[0]!["subagents"], undefined);
    assert.equal(jobs[0]!["browser"], undefined);
  });

  test("the follow-up and its instruction ride on jobs.save, and an older build's edit leaves them be", async () => {
    const save = (extra: Record<string, unknown>) => JSON.stringify({
      type: "jobs.save", name: "Veille", prompt: "watch it", schedule: "every 1h", enabled: true,
      skills: { mode: "inherit" }, mcp: { mode: "inherit" }, tools: { mode: "inherit" }, ...extra,
    });
    client.ws.send(save({ followUp: true, followUpPrompt: "Mets à jour le workspace." }));
    const on = (((await nextFrame(client))["jobs"]) as Array<Record<string, unknown>>)[0]!;
    assert.equal(on["followUp"], true);
    assert.equal(on["followUpPrompt"], "Mets à jour le workspace.");

    // An app that predates the option sends neither field: the job keeps both.
    client.ws.send(save({ id: jobs[0]!["id"] }));
    const kept = (((await nextFrame(client))["jobs"]) as Array<Record<string, unknown>>)[0]!;
    assert.equal(kept["followUp"], true);
    assert.equal(kept["followUpPrompt"], "Mets à jour le workspace.");

    client.ws.send(save({ id: jobs[0]!["id"], followUp: false, followUpPrompt: "" }));
    const off = (((await nextFrame(client))["jobs"]) as Array<Record<string, unknown>>)[0]!;
    assert.equal(off["followUp"], false);
    assert.equal(off["followUpPrompt"], undefined);
    assert.equal("followUp" in jobs[0]!, false);
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
    callers: async (threadId: string, caller: string) => {
      asked.push(`callers:${threadId}:${caller}`);
      return [{ sessionId: "my-claw-app/thread/test-device/main", threadId: "main", creator: true, firstAt: "2026-01-01T00:00:00.000Z", lastAt: "2026-01-02T00:00:00.000Z", runs: 2, title: "Parent" }];
    },
    handoff: async (input: { threadId: string; targets: string[]; body: string; mode: string }) => {
      asked.push(`handoff:${input.threadId}:${input.mode}:${input.targets.join(",")}:${input.body}`);
      return input.targets.map((t) => ({ sessionId: t, threadId: "main", ok: true }));
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

  test("subagents.callers answers the asking socket alone", async () => {
    adapter.onSubAgentsController(controller());
    client.ws.send(JSON.stringify({ type: "subagents.callers", threadId: "sub-0123456789abcdef", parentThreadId: "main" }));
    const frame = await nextFrame(client);
    assert.equal(frame["type"], "subagents.callers.result");
    assert.equal(frame["threadId"], "sub-0123456789abcdef");
    const callers = frame["callers"] as Array<Record<string, unknown>>;
    assert.equal(callers[0]?.["creator"], true);
    assert.deepEqual(asked, ["callers:sub-0123456789abcdef:my-claw-app/thread/test-device/main"]);
  });

  // Unreachable and missing answer the same way, so a refusal cannot be read as "it exists".
  test("an unreachable sub-agent refuses the caller list", async () => {
    adapter.onSubAgentsController(controller({ callers: async () => undefined }));
    client.ws.send(JSON.stringify({ type: "subagents.callers", threadId: "sub-0123456789abcdef", parentThreadId: "main" }));
    const frame = await nextFrame(client);
    assert.equal(frame["type"], "error");
    assert.equal(frame["scope"], "subagents");
    assert.match(String(frame["message"]), /not found/);
  });

  test("subagents.handoff refuses an empty target list without asking the runner", async () => {
    adapter.onSubAgentsController(controller());
    client.ws.send(JSON.stringify({ type: "subagents.handoff", threadId: "sub-0123456789abcdef", parentThreadId: "main", targets: [], mode: "ask" }));
    const frame = await nextFrame(client);
    assert.equal(frame["type"], "error");
    assert.equal(frame["scope"], "subagents");
    assert.deepEqual(asked, []);
  });

  test("a handoff with nothing to hand back is refused, not delivered empty", async () => {
    adapter.onSubAgentsController(controller());
    client.ws.send(JSON.stringify({ type: "subagents.handoff", threadId: "sub-0123456789abcdef", parentThreadId: "main", targets: ["my-claw-app/thread/test-device/main"], mode: "ask" }));
    const frame = await nextFrame(client);
    assert.equal(frame["type"], "error");
    assert.equal(frame["scope"], "subagents");
    assert.match(String(frame["message"]), /nothing to hand back/);
    assert.deepEqual(asked, []);
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
  const channelUpdates: Array<{ deviceId: string; channels: { ordinary?: string; ring?: string } }> = [];

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
      setChannels: async (deviceId, channels) => { channelUpdates.push({ deviceId, channels }); },
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
    channelUpdates.length = 0;
  });

  test("a connecting device is greeted with the VAPID public key", async () => {
    const info = await nextFrame(client);
    assert.equal(info["type"], "notifications.info");
    assert.equal(info["vapidPublicKey"], "vapid-public-key");
  });

  test("the last APNs socket closing clears foreground suppression", async () => {
    const closed = Promise.withResolvers<void>();
    const writes: boolean[] = [];
    adapter.onNotificationsController({ info: async () => "vapid", register: async () => {}, unregister: async () => {},
      setForeground: async (_, state) => { writes.push(state.foreground); if (!state.foreground) closed.resolve(); },
      setChannels: async () => {}, apns: { relayURL: "https://relay.example", register: async () => {}, unregister: async () => {} } });
    client.ws.close(); await closed.promise;
    assert.deepEqual(writes, [false]);
  });

  test("APNs JSON frames register only the authenticated device and reject malformed credentials", async () => {
    const received: Array<{ deviceId: string; registrationId: string; secret: string }> = [];
    adapter.onNotificationsController({ info: async () => "vapid", register: async () => {}, unregister: async () => {},
      setForeground: async () => {}, setChannels: async () => {}, apns: { relayURL: "https://relay.example",
        register: async (deviceId, value) => { received.push({ deviceId, ...value }); }, unregister: async () => {} } });
    const registrationId = "11111111-1111-4111-8111-111111111111";
    client.ws.send(JSON.stringify({ type: "notifications.apns.register", registrationId, secret: "s".repeat(43), deviceId: "other" }));
    let result;
    do { result = await nextFrame(client); } while (result["type"] !== "notifications.apns.result");
    assert.equal(result["ok"], true);
    assert.deepEqual(received, [{ deviceId: DEVICE_ID, registrationId, secret: "s".repeat(43) }]);
    client.ws.send(JSON.stringify({ type: "notifications.apns.register", registrationId: "../evil", secret: "short" }));
    assert.equal((await nextFrame(client))["ok"], false); assert.equal(received.length, 1);
    client.ws.send(JSON.stringify({ type: "notifications.apns.unregister" }));
    assert.equal((await nextFrame(client))["ok"], true);
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

  test("notifications.channels records the sounds under the socket's own device", async () => {
    client.ws.send(JSON.stringify({
      type: "notifications.channels",
      deviceId: "someone-else",
      channels: { ordinary: "quiet-1a2b", ring: "ring-3f9a" },
    }));
    await until(() => channelUpdates.length === 1);
    // The frame's deviceId is ignored: the authenticated socket is the only device it can write.
    assert.deepEqual(channelUpdates, [{ deviceId: DEVICE_ID, channels: { ordinary: "quiet-1a2b", ring: "ring-3f9a" } }]);
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

describe("question frames", () => {
  let adapter: MyClawAppAdapter;
  let client: WsClient;
  let store: FakeSessionStore;
  let messages: Array<{ text: string; threadId: string }>;
  const sessionIdOf = (thread: string) => `my-claw-app/thread/${DEVICE_ID}/${thread}`;

  beforeEach(async () => {
    store = new FakeSessionStore();
    messages = [];
    adapter = new MyClawAppAdapter(createConfig(), store as never);
    adapter.onMessage(async (msg: UnifiedMessage) => {
      messages.push({ text: msg.text, threadId: msg.threadId ?? "" });
    });
    await adapter.start();
    client = await connectClient(adapter.port);
  });

  afterEach(async () => {
    client.ws.close();
    await adapter.stop();
  });

  test("question.ask is broadcast and question.reply closes it everywhere", async () => {
    const ask = questionManager.ask({
      sessionId: sessionIdOf("t-ask"),
      owner: DEVICE_ID,
      threadId: "t-ask",
      questions: [{ header: "Langue", question: "FR ou EN ?", options: [{ label: "fr" }] }],
    });
    const asked = await nextFrame(client);
    assert.equal(asked["type"], "question.ask");
    assert.equal(asked["threadId"], "t-ask");
    const id = asked["id"] as string;

    client.ws.send(JSON.stringify({ type: "question.reply", id, answers: [["fr"]] }));
    const resolved = await nextFrame(client);
    assert.equal(resolved["type"], "question.resolved");
    assert.equal(resolved["reason"], "answered");
    const outcome = await ask;
    assert.deepEqual(outcome, { kind: "answered", answers: [["fr"]] });
  });

  test("chat.send while a question is pending cancels it and routes the message", async () => {
    const ask = questionManager.ask({
      sessionId: sessionIdOf("t-send"),
      owner: DEVICE_ID,
      threadId: "t-send",
      questions: [{ header: "h", question: "q", options: [{ label: "a" }] }],
    });
    const asked = await nextFrame(client);
    assert.equal(asked["type"], "question.ask");

    client.ws.send(JSON.stringify({ type: "chat.send", id: "q1", text: "finalement non", threadId: "t-send" }));
    const resolved = await nextFrame(client);
    assert.equal(resolved["type"], "question.resolved");
    assert.equal(resolved["reason"], "canceled");
    const outcome = await ask;
    assert.deepEqual(outcome, { kind: "canceled" });
    // The message reaches the agent normally.
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(messages, [{ text: "finalement non", threadId: "t-send" }]);
  });

  test("a slash command does not cancel a pending question", async () => {
    const ask = questionManager.ask({
      sessionId: sessionIdOf("t-cmd"),
      owner: DEVICE_ID,
      threadId: "t-cmd",
      questions: [{ header: "h", question: "q", options: [{ label: "a" }] }],
    });
    const asked = await nextFrame(client);
    assert.equal(asked["type"], "question.ask");
    // Without a command handler the frame falls through to the agent; either way the question
    // must stay pending -- a slash command is not steering.
    client.ws.send(JSON.stringify({ type: "chat.send", id: "q2", text: "/status", threadId: "t-cmd" }));
    await new Promise((r) => setTimeout(r, 150));
    assert.ok(questionManager.ofSession(sessionIdOf("t-cmd")), "question still pending");
    // Cancel and settle so the test does not leak a pending ask into the next one.
    questionManager.cancel(asked["id"] as string);
    assert.deepEqual(await ask, { kind: "canceled" });
  });

  test("a connecting device is handed every question still waiting", async () => {
    // Nothing pending: the list is still sent, and it is empty. That empty list is what clears a
    // card a client kept from a server that died holding the question.
    const fresh = await connectClient(adapter.port, DEVICE_ID, TOKEN, false, false, true);
    const empty = await nextFrame(fresh);
    assert.equal(empty["type"], "question.pending");
    assert.deepEqual(empty["entries"], []);
    fresh.ws.close();

    const ask = questionManager.ask({
      sessionId: sessionIdOf("t-seed"),
      owner: DEVICE_ID,
      threadId: "t-seed",
      questions: [{ header: "h", question: "q", options: [{ label: "a" }] }],
      replyToId: "call-1",
    });
    const asked = await nextFrame(client);
    assert.equal(asked["type"], "question.ask");
    // The card id, not the model's raw call id: the app draws the form inside that tool card.
    assert.equal(asked["replyToId"], "t-call-1");

    const late = await connectClient(adapter.port, DEVICE_ID, TOKEN, false, false, true);
    const pending = await nextFrame(late);
    assert.equal(pending["type"], "question.pending");
    const entries = pending["entries"] as Array<Record<string, unknown>>;
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!["id"], asked["id"]);
    assert.equal(entries[0]!["threadId"], "t-seed");
    assert.equal(entries[0]!["replyToId"], "t-call-1");
    late.ws.close();

    questionManager.cancel(asked["id"] as string);
    assert.deepEqual(await ask, { kind: "canceled" });
  });

  test("chat.stop while a question is pending cancels it without stopping the run", async () => {
    let stopped = false;
    adapter.onStop(() => {
      stopped = true;
      return "stopped";
    });
    const ask = questionManager.ask({
      sessionId: sessionIdOf("t-stop"),
      owner: DEVICE_ID,
      threadId: "t-stop",
      questions: [{ header: "h", question: "q", options: [{ label: "a" }] }],
    });
    const asked = await nextFrame(client);
    assert.equal(asked["type"], "question.ask");

    client.ws.send(JSON.stringify({ type: "chat.stop", threadId: "t-stop" }));
    const resolved = await nextFrame(client);
    assert.equal(resolved["type"], "question.resolved");
    assert.equal(resolved["reason"], "canceled");
    assert.equal(stopped, false, "a question cancel must not abort the run");
    const outcome = await ask;
    assert.deepEqual(outcome, { kind: "canceled" });
  });
});

describe("files page", () => {
  let adapter: MyClawAppAdapter;
  let client: WsClient;
  let store: FakeSessionStore;
  let root: string;
  const guards = () => ({
    home: join(root, "home"),
    myClawDir: join(root, "data"),
    defaultWorkspace: join(root, "workspace"),
    cwd: join(root, "proj"),
  });

  beforeEach(async () => {
    store = new FakeSessionStore();
    adapter = new MyClawAppAdapter(createConfig(), store as never);
    await adapter.start();
    client = await connectClient(adapter.port);
    root = mkdtempSync(join(tmpdir(), "adapter-fs-"));
    mkdirSync(join(root, "data"), { recursive: true });
    writeFileSync(join(root, "data", "keep.txt"), "keep");
  });

  afterEach(async () => {
    client.ws.close();
    await adapter.stop();
    rmSync(root, { recursive: true, force: true });
  });

  test("list, read, write and session.root answer over the socket, and a guarded remove names its reason", async () => {
    const dir = join(root, "project");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "notes.txt"), "hello\n");
    adapter.onFsProvider({ sessionRoot: async () => dir, protectedRoots: guards });

    client.ws.send(JSON.stringify({ type: "fs.session.root", threadId: "default" }));
    const opened = await nextFrame(client);
    assert.equal(opened["type"], "fs.session.root.result");
    assert.equal(opened["path"], dir);

    client.ws.send(JSON.stringify({ type: "fs.list", path: dir }));
    const listing = await nextFrame(client);
    assert.equal(listing["type"], "fs.list.result");
    assert.equal(listing["path"], dir);
    assert.deepEqual((listing["entries"] as Array<Record<string, unknown>>).map((entry) => entry["name"]), ["notes.txt"]);

    client.ws.send(JSON.stringify({ type: "fs.read", path: join(dir, "notes.txt") }));
    const read = await nextFrame(client);
    assert.equal(read["type"], "fs.read.result");
    assert.equal(read["text"], "hello\n");
    assert.equal(read["encoding"], "utf8");
    assert.equal(read["eol"], "lf");

    client.ws.send(JSON.stringify({ type: "fs.write", path: join(dir, "notes.txt"), text: "changed\n", etag: read["etag"] }));
    const saved = await nextFrame(client);
    assert.equal(saved["type"], "fs.write.result");
    assert.equal(typeof saved["etag"], "string");
    assert.equal(saved["etag"] === read["etag"], false);
    assert.equal(await readFile(join(dir, "notes.txt"), "utf8"), "changed\n");

    client.ws.send(JSON.stringify({ type: "fs.remove", path: join(root, "data"), recursive: true }));
    const refused = await nextFrame(client);
    assert.equal(refused["type"], "error");
    assert.equal(refused["scope"], "fs");
    assert.match(String(refused["message"]), /my-claw data directory/);
    assert.equal(existsSync(join(root, "data", "keep.txt")), true);
  });

  test("a watched file pushes fs.changed, and the socket's watchers die with the socket", async () => {
    const file = join(root, "tail.log");
    writeFileSync(file, "a\n");
    adapter.onFsProvider({ sessionRoot: async () => root, protectedRoots: guards });

    client.ws.send(JSON.stringify({ type: "fs.watch", path: file }));
    const watching = await nextFrame(client);
    assert.equal(watching["type"], "fs.watch.result");
    assert.equal(watching["watching"], true);

    let changed: Record<string, unknown> | undefined;
    const deadline = Date.now() + 10_000;
    while (!changed) {
      if (Date.now() > deadline) throw new Error("no fs.changed over the wire");
      appendFileSync(file, "b\n");
      await new Promise((r) => setTimeout(r, 80));
      const index = client.frames.findIndex((frame) => (frame as { type?: string }).type === "fs.changed");
      if (index >= 0) changed = client.frames.splice(index, 1)[0] as Record<string, unknown>;
    }
    assert.equal(changed["path"], file);
    assert.equal(changed["kind"], "changed");

    // The watcher set belongs to the socket: a disconnect drops it, which is the one owner that
    // can outlive the page the owner just closed.
    const dropSpy = spyOn(FsWatchRegistry.prototype, "drop");
    try {
      client.ws.close();
      await waitUntil(() => dropSpy.mock.calls.length > 0);
    } finally {
      dropSpy.mockRestore();
    }
  });

  test("the transfer routes take the same credential as the APK relay", async () => {
    const file = join(root, "download.txt");
    writeFileSync(file, "bytes\n");
    const base = `http://127.0.0.1:${adapter.port}`;
    const auth = `device=${DEVICE_ID}&token=${TOKEN}`;

    const unauth = await fetch(`${base}/fs/download?path=${encodeURIComponent(file)}`);
    assert.equal(unauth.status, 401);

    const download = await fetch(`${base}/fs/download?path=${encodeURIComponent(file)}&${auth}`);
    assert.equal(download.status, 200);
    assert.equal(await download.text(), "bytes\n");
    assert.match(download.headers.get("content-disposition") ?? "", /attachment/);

    const withoutAuth = new FormData();
    withoutAuth.append("f", new File(["uploaded\n"], "up.txt"));
    const noAuth = await fetch(`${base}/fs/upload?path=${encodeURIComponent(root)}`, { method: "POST", body: withoutAuth });
    assert.equal(noAuth.status, 401);

    const withAuth = new FormData();
    withAuth.append("f", new File(["uploaded\n"], "up.txt"));
    const upload = await fetch(`${base}/fs/upload?path=${encodeURIComponent(root)}&${auth}`, { method: "POST", body: withAuth });
    assert.equal(upload.status, 200);
    assert.equal(await readFile(join(root, "up.txt"), "utf8"), "uploaded\n");
  });
});
