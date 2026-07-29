import { test, afterAll } from "bun:test";
import assert from "node:assert/strict";
import { mockFetch } from "./helpers/mock-fetch.ts";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MatrixAdapter } from "../src/channels/matrix/adapter.ts";
import type { MatrixChannelConfig } from "../src/core/config.ts";
import { MessageRouter } from "../src/core/router.ts";
import { SessionManager } from "../src/sessions/manager.ts";
import { AgentBridge } from "../src/agent/bridge.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { SkillRegistry } from "../src/skills/registry.ts";
import {
  createMatrixActionHandler,
  createMatrixApprovalHandler,
  type MatrixApprovalHandler,
} from "../src/channels/matrix/session-handlers.ts";
import { ModelPicker } from "../src/channels/model-picker.ts";
import { resolveMatrixRuntimeStoragePaths } from "../src/channels/matrix/storage.ts";
import type { MyClawConfig } from "../src/core/config.ts";

type MatrixEventContentMock = Record<string, unknown>;
type MatrixFetchedEventMock = {
  sender?: string;
  event_id?: string;
  type?: string;
  content: MatrixEventContentMock;
};
type MatrixRelationEventMock = {
  event_id?: string;
  sender?: string;
  type?: string;
  origin_server_ts?: number;
  content?: MatrixEventContentMock;
  unsigned?: {
    redacted_because?: unknown;
  };
};
type MatrixRelationsResponseMock = {
  chunk: MatrixRelationEventMock[];
  next_batch?: string;
};

const runtimeTempDirs = new Set<string>();

afterAll(async () => {
  await Promise.allSettled(
    [...runtimeTempDirs].map(async (dir) => {
      runtimeTempDirs.delete(dir);
      await rm(dir, { recursive: true, force: true });
    }),
  );
});

function createRuntimeMock(options: { persistedSyncState?: boolean; storageRootDir?: string; encryptionReady?: boolean } = {}) {
  const storageRootDir =
    options.storageRootDir ??
    join(
      tmpdir(),
      `my-claw-matrix-adapter-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
  runtimeTempDirs.add(storageRootDir);
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const timelineHandlers: Array<(
    payload: { room: unknown; event: unknown; toStartOfTimeline: boolean; removed: boolean; liveEvent: boolean },
  ) => void | Promise<void>> = [];
  let encryptedRooms = new Set<string>();
  const sdk: {
    on: () => void;
    off: () => void;
    sendMessage: (...args: unknown[]) => Promise<{ event_id: string }>;
    sendEvent: (...args: unknown[]) => Promise<{ event_id: string }>;
    uploadContent: (...args: unknown[]) => Promise<{ content_uri: string }>;
    redactEvent: (...args: unknown[]) => Promise<{ event_id: string }>;
    sendReadReceipt: (...args: unknown[]) => Promise<Record<string, never>>;
    sendTyping: (...args: unknown[]) => Promise<Record<string, never>>;
    mxcUrlToHttp: (mxc: string) => string;
    getCrypto: () => { decryptMedia: (file: { url: string }) => Promise<Buffer> };
    getUserId: () => string;
    getRoom: () => { findEventById: () => Record<string, never> };
    fetchRoomEvent: (_roomId: string, eventId: string) => Promise<MatrixFetchedEventMock>;
    fetchRelations: (
      _roomId: string,
      _eventId: string,
      _relationType?: string | null,
      _eventType?: string | null,
      _opts?: Record<string, unknown>,
    ) => Promise<MatrixRelationsResponseMock>;
  } = {
    on() {},
    off() {},
    async sendMessage(...args: unknown[]) {
      calls.push({ method: "sendMessage", args });
      return { event_id: "$evt1" };
    },
    async sendEvent(...args: unknown[]) {
      calls.push({ method: "sendEvent", args });
      return { event_id: `$react-${calls.length}` };
    },
    async uploadContent(...args: unknown[]) {
      calls.push({ method: "uploadContent", args });
      return { content_uri: "mxc://example.org/file" };
    },
    async redactEvent(...args: unknown[]) {
      calls.push({ method: "redactEvent", args });
      return { event_id: "$redact1" };
    },
    async sendReadReceipt(...args: unknown[]) {
      calls.push({ method: "sendReadReceipt", args });
      return {};
    },
    async sendTyping(...args: unknown[]) {
      calls.push({ method: "sendTyping", args });
      return {};
    },
    mxcUrlToHttp(mxc: string) {
      return mxc.replace("mxc://", "https://cdn.example/");
    },
    getCrypto() {
      return {
        async decryptMedia(file: { url: string }) {
          return Buffer.from(`decrypted:${file.url}`);
        },
      };
    },
    getUserId() {
      return "@bot:example.org";
    },
    getRoom() {
      return {
        findEventById: () => ({}),
      };
    },
    async fetchRoomEvent(_roomId: string, eventId: string) {
      if (eventId === "$reply") {
        return {
          sender: "@alice:example.org",
          content: { msgtype: "m.text", body: "quoted message" },
        };
      }
      if (eventId === "$thread-root") {
        return {
          sender: "@alice:example.org",
          content: { msgtype: "m.image", body: "image.png", filename: "image.png" },
        };
      }
      return {
        sender: "@alice:example.org",
        content: { msgtype: "m.text", body: "fallback" },
      };
    },
    async fetchRelations() {
      return { chunk: [] };
    },
  };

  return {
    calls,
    runtime: {
      sdk,
      mediaCrypto: options.encryptionReady === false
        ? undefined
        : {
            async decryptMedia(file: { url: string }) {
              return Buffer.from(`decrypted:${file.url}`);
            },
            async encryptMedia(buffer: Buffer) {
              return {
                buffer: Buffer.from(`encrypted:${buffer.toString("utf8")}`),
                file: {
                  key: { kty: "oct" },
                  iv: "iv",
                  hashes: { sha256: "hash" },
                  v: "v2",
                },
              };
            },
            async isRoomEncrypted(roomId: string) {
              return encryptedRooms.has(roomId);
            },
          },
      encryptionReady() {
        return options.encryptionReady !== false;
      },
      onTimeline(
        handler: (
          payload: { room: unknown; event: unknown; toStartOfTimeline: boolean; removed: boolean; liveEvent: boolean },
        ) => void | Promise<void>,
      ) {
        timelineHandlers.push(handler);
        return () => {
          const index = timelineHandlers.indexOf(handler);
          if (index >= 0) {
            timelineHandlers.splice(index, 1);
          }
        };
      },
      async start() {},
      async stop() {},
      hasPersistedSyncState() {
        return options.persistedSyncState === true;
      },
      getStoragePaths() {
        return resolveMatrixRuntimeStoragePaths(
          {
            homeserver: "https://matrix.example.org",
            accessToken: "token",
            userId: "@bot:example.org",
          },
          storageRootDir,
        );
      },
      setEncryptedRooms(roomIds: string[]) {
        encryptedRooms = new Set(roomIds);
      },
      async emitTimeline(payload: {
        room: unknown;
        event: unknown;
        toStartOfTimeline?: boolean;
        removed?: boolean;
        liveEvent?: boolean;
      }) {
        for (const handler of timelineHandlers) {
          await Promise.resolve(
            handler({
              room: payload.room,
              event: payload.event,
              toStartOfTimeline: payload.toStartOfTimeline ?? false,
              removed: payload.removed ?? false,
              liveEvent: payload.liveEvent ?? true,
            }),
          ).catch(() => undefined);
        }
      },
    },
  };
}

function createConfig(overrides: Partial<MatrixChannelConfig> = {}): MatrixChannelConfig {
  const base: MatrixChannelConfig = {
    homeserver: "https://matrix.example.org",
    accessToken: "token",
    userId: "@bot:example.org",
    botUserIds: ["@helperbot:example.org"],
    streaming: { enabled: true, minChars: 1, throttleMs: 0 },
    reactions: { enabled: true },
    errorPolicy: "always",
    dm: { enabled: true, policy: "allowlist", allowFrom: ["@u1:example.org"] },
    groupPolicy: "allowlist",
    groupAllowFrom: ["@u1:example.org"],
    groups: { "*": { enabled: true, autoReply: true } },
  };

  return {
    ...base,
    ...overrides,
    dm: overrides.dm ? { ...base.dm, ...overrides.dm } : base.dm,
    streaming: overrides.streaming ? { ...base.streaming, ...overrides.streaming } : base.streaming,
    reactions: overrides.reactions ? { ...base.reactions, ...overrides.reactions } : base.reactions,
  };
}

function createRoom(overrides: Partial<{ roomId: string; inviter: string | undefined; joinedMembers: string[] }> = {}) {
  const joinedMembers = overrides.joinedMembers ?? ["@bot:example.org", "@u1:example.org"];
  const timelineEvents = [
    createEvent({ id: "$old1", sender: "@u2:example.org", content: { msgtype: "m.text", body: "older one" } }),
    createEvent({ id: "$old2", sender: "@u3:example.org", content: { msgtype: "m.text", body: "older two" } }),
  ];

  return {
    roomId: overrides.roomId ?? "!room:test",
    getJoinedMembers() {
      return joinedMembers.map((userId) => ({
        userId,
        name: userId.includes("bot") ? "Bot User" : userId,
      }));
    },
    getMember(userId: string) {
      return joinedMembers.includes(userId)
        ? { userId, name: userId.includes("bot") ? "Bot User" : userId }
        : null;
    },
    getDMInviter() {
      return overrides.inviter;
    },
    getLiveTimeline() {
      return {
        getEvents() {
          return timelineEvents;
        },
      };
    },
  };
}

function createEvent(overrides: Partial<Record<string, unknown>> = {}) {
  const content = (overrides.content as Record<string, unknown> | undefined) ?? {
    msgtype: "m.text",
    body: "hello",
  };
  return {
    getType() {
      return overrides.type ?? "m.room.message";
    },
    isRelation(relType?: string) {
      return relType === "m.replace" ? overrides.isReplace === true : false;
    },
    getSender() {
      return overrides.sender ?? "@u1:example.org";
    },
    getContent() {
      return content;
    },
    getRelation() {
      return overrides.relation ?? null;
    },
    getThread() {
      return overrides.thread ?? undefined;
    },
    getId() {
      return overrides.id ?? "$evt1";
    },
    getTs() {
      return (overrides.ts as number | undefined) ?? Date.now();
    },
    getUnsigned() {
      return (overrides.unsigned as Record<string, unknown> | undefined) ?? {};
    },
    isDecryptionFailure() {
      return overrides.isDecryptionFailure === true;
    },
  };
}

// Poll until a condition holds (buffered/coalesced emits use real 25ms timers;
// a fixed sleep is flaky on loaded CI). Resolves as soon as the predicate is true,
// or gives up after `timeout` so the following assertions report the real state.
async function waitFor(predicate: () => boolean, timeout = 2000, interval = 5): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) return;
    await new Promise((r) => setTimeout(r, interval));
  }
}

// 25ms was tight enough that on a loaded machine the window closed between two emitTimeline calls:
// the burst stopped coalescing and `received.length >= 1` was satisfied by a message that should
// have been merged, so the following assert.equal(1) saw 2. The window is a test knob, not the
// contract, so it is widened well past the emit jitter; no test forces a flush by sleeping.
const BUFFERED_INGRESS_MS = 250;

class TestMatrixAdapter extends MatrixAdapter {
  protected override bufferedIngressDelayMs(): number {
    return BUFFERED_INGRESS_MS;
  }
  protected override bufferedIngressDelayForMessage(): number {
    return BUFFERED_INGRESS_MS;
  }
}

test("MatrixAdapter send emits formatted Matrix message", async () => {
  const { runtime, calls } = createRuntimeMock();
  const adapter = new MatrixAdapter(createConfig(), new Set(["@u1:example.org"]), runtime as never);

  await adapter.send("!room:test", { text: "hello **world**" });

  assert.equal(calls[0]?.method, "sendMessage");
  const payload = calls[0]?.args[1] as Record<string, unknown>;
  assert.equal(payload["msgtype"], "m.text");
  assert.equal(payload["body"], "hello **world**");
  assert.ok(typeof payload["formatted_body"] === "string");
});

test("MatrixAdapter processes authorized inbound message", async () => {
  const { runtime, calls } = createRuntimeMock();
  const adapter = new MatrixAdapter(createConfig(), new Set(["@u1:example.org"]), runtime as never);
  const received: string[] = [];

  adapter.onMessage(async (message) => {
    received.push(message.text);
  });

  await adapter.start();
  await runtime.emitTimeline({ room: createRoom(), event: createEvent() });

  assert.deepEqual(received, ["hello"]);
  assert.equal(calls.some((call) => call.method === "sendTyping"), true);
});

test("MatrixAdapter ignores non-live timeline replays", async () => {
  const { runtime } = createRuntimeMock();
  const adapter = new MatrixAdapter(createConfig(), new Set(["@u1:example.org"]), runtime as never);
  const received: string[] = [];

  adapter.onMessage(async (message) => {
    received.push(message.text);
  });

  await adapter.start();
  await runtime.emitTimeline({
    room: createRoom(),
    event: createEvent({ id: "$replayed" }),
    liveEvent: false,
  });

  assert.deepEqual(received, []);
});

test("MatrixAdapter ignores duplicate live event ids", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "my-claw-matrix-adapter-"));
  try {
    const { runtime } = createRuntimeMock({ storageRootDir: tempDir });
    const adapter = new MatrixAdapter(createConfig(), new Set(["@u1:example.org"]), runtime as never);
    const received: string[] = [];

    adapter.onMessage(async (message) => {
      received.push(message.text);
    });

    await adapter.start();
    await runtime.emitTimeline({ room: createRoom(), event: createEvent({ id: "$dup-live" }) });
    await runtime.emitTimeline({ room: createRoom(), event: createEvent({ id: "$dup-live" }) });

    assert.deepEqual(received, ["hello"]);
    await adapter.stop();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("MatrixAdapter drops cold-start backlog older than startup", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "my-claw-matrix-adapter-"));
  try {
    const { runtime } = createRuntimeMock({ storageRootDir: tempDir, persistedSyncState: false });
    const adapter = new MatrixAdapter(createConfig(), new Set(["@u1:example.org"]), runtime as never);
    const received: string[] = [];

    adapter.onMessage(async (message) => {
      received.push(message.text);
    });

    const oldTs = Date.now() - 60_000;
    await adapter.start();
    await runtime.emitTimeline({ room: createRoom(), event: createEvent({ id: "$cold-old", ts: oldTs }) });
    await runtime.emitTimeline({ room: createRoom(), event: createEvent({ id: "$cold-fresh" }) });

    assert.deepEqual(received, ["hello"]);
    await adapter.stop();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("MatrixAdapter keeps replay after clean shutdown persisted sync", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "my-claw-matrix-adapter-"));
  try {
    const firstRuntime = createRuntimeMock({ storageRootDir: tempDir, persistedSyncState: false });
    const firstAdapter = new MatrixAdapter(createConfig(), new Set(["@u1:example.org"]), firstRuntime.runtime as never);
    await firstAdapter.start();
    await firstAdapter.stop();

    const secondRuntime = createRuntimeMock({ storageRootDir: tempDir, persistedSyncState: true });
    const secondAdapter = new MatrixAdapter(createConfig(), new Set(["@u1:example.org"]), secondRuntime.runtime as never);
    const received: string[] = [];

    secondAdapter.onMessage(async (message) => {
      received.push(message.text);
    });

    await secondAdapter.start();
    await secondRuntime.runtime.emitTimeline({
      room: createRoom(),
      event: createEvent({ id: "$restart-backlog", ts: Date.now() - 60_000 }),
    });

    assert.deepEqual(received, ["hello"]);
    await secondAdapter.stop();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("MatrixAdapter retries failed inbound events on restart before commit", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "my-claw-matrix-adapter-"));
  try {
    const firstRuntime = createRuntimeMock({ storageRootDir: tempDir });
    const firstAdapter = new MatrixAdapter(createConfig(), new Set(["@u1:example.org"]), firstRuntime.runtime as never);
    const firstReceived: string[] = [];

    firstAdapter.onMessage(async (message) => {
      firstReceived.push(message.text);
      throw new Error("boom");
    });

    await firstAdapter.start();
    await firstRuntime.runtime.emitTimeline({ room: createRoom(), event: createEvent({ id: "$retry-me" }) });
    assert.deepEqual(firstReceived, ["hello"]);
    await firstAdapter.stop();

    const secondRuntime = createRuntimeMock({ storageRootDir: tempDir });
    const secondAdapter = new MatrixAdapter(createConfig(), new Set(["@u1:example.org"]), secondRuntime.runtime as never);
    const retried: string[] = [];

    secondAdapter.onMessage(async (message) => {
      retried.push(message.text);
    });

    await secondAdapter.start();
    await secondRuntime.runtime.emitTimeline({ room: createRoom(), event: createEvent({ id: "$retry-me" }) });

    assert.deepEqual(retried, ["hello"]);
    await secondAdapter.stop();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("MatrixAdapter does not replay committed inbound events after restart", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "my-claw-matrix-adapter-"));
  try {
    const firstRuntime = createRuntimeMock({ storageRootDir: tempDir });
    const firstAdapter = new MatrixAdapter(createConfig(), new Set(["@u1:example.org"]), firstRuntime.runtime as never);
    const firstReceived: string[] = [];

    firstAdapter.onMessage(async (message) => {
      firstReceived.push(message.text);
    });

    await firstAdapter.start();
    await firstRuntime.runtime.emitTimeline({ room: createRoom(), event: createEvent({ id: "$committed" }) });
    assert.deepEqual(firstReceived, ["hello"]);
    await firstAdapter.stop();

    const secondRuntime = createRuntimeMock({ storageRootDir: tempDir });
    const secondAdapter = new MatrixAdapter(createConfig(), new Set(["@u1:example.org"]), secondRuntime.runtime as never);
    const retried: string[] = [];

    secondAdapter.onMessage(async (message) => {
      retried.push(message.text);
    });

    await secondAdapter.start();
    await secondRuntime.runtime.emitTimeline({ room: createRoom(), event: createEvent({ id: "$committed" }) });

    assert.deepEqual(retried, []);
    await secondAdapter.stop();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("MatrixAdapter marks DM messages with configured per-room session scope", async () => {
  const { runtime } = createRuntimeMock();
  const adapter = new MatrixAdapter(
    createConfig({ dm: { sessionScope: "per-room", allowFrom: ["@u1:example.org"] } }),
    new Set(["@u1:example.org"]),
    runtime as never,
  );
  const receivedScopes: Array<"per-user" | "per-room" | "per-chat" | undefined> = [];

  adapter.onMessage(async (message) => {
    receivedScopes.push(message.sessionScope);
  });

  await adapter.start();
  await runtime.emitTimeline({
    room: createRoom({ inviter: "@u1:example.org", joinedMembers: ["@bot:example.org", "@u1:example.org"] }),
    event: createEvent(),
  });

  assert.deepEqual(receivedScopes, ["per-room"]);
});

test("MatrixAdapter keeps short DM split turns immediate in per-user scope", async () => {
  const { runtime } = createRuntimeMock();
  const adapter = new TestMatrixAdapter(createConfig(), new Set(["@u1:example.org"]), runtime as never);
  const received: string[] = [];

  adapter.onMessage(async (message) => {
    received.push(message.text);
  });

  await adapter.start();
  await runtime.emitTimeline({
    room: createRoom({ roomId: "!dm-a:test", inviter: "@u1:example.org", joinedMembers: ["@bot:example.org", "@u1:example.org"] }),
    event: createEvent({ id: "$dm1", content: { msgtype: "m.text", body: "hello" } }),
  });
  await runtime.emitTimeline({
    room: createRoom({ roomId: "!dm-a:test", inviter: "@u1:example.org", joinedMembers: ["@bot:example.org", "@u1:example.org"] }),
    event: createEvent({ id: "$dm2", content: { msgtype: "m.text", body: "again" } }),
  });
  await waitFor(() => received.length >= 2);

  assert.deepEqual(received, ["hello", "again"]);
});

test("MatrixAdapter does not coalesce DM split turns across per-room sessions", async () => {
  const { runtime } = createRuntimeMock();
  const adapter = new TestMatrixAdapter(
    createConfig({ dm: { sessionScope: "per-room", allowFrom: ["@u1:example.org"] } }),
    new Set(["@u1:example.org"]),
    runtime as never,
  );
  const received: Array<{ chatId: string; text: string }> = [];

  adapter.onMessage(async (message) => {
    received.push({ chatId: message.chatId, text: message.text });
  });

  await adapter.start();
  await runtime.emitTimeline({
    room: createRoom({ roomId: "!dm-a:test", inviter: "@u1:example.org", joinedMembers: ["@bot:example.org", "@u1:example.org"] }),
    event: createEvent({ id: "$dm-room-a", content: { msgtype: "m.text", body: "hello" } }),
  });
  await runtime.emitTimeline({
    room: createRoom({ roomId: "!dm-b:test", inviter: "@u1:example.org", joinedMembers: ["@bot:example.org", "@u1:example.org"] }),
    event: createEvent({ id: "$dm-room-b", content: { msgtype: "m.text", body: "again" } }),
  });
  await waitFor(() => received.length >= 2);

  assert.deepEqual(received, [
    { chatId: "!dm-a:test", text: "hello" },
    { chatId: "!dm-b:test", text: "again" },
  ]);
});

test("MatrixAdapter handles matrix commands inline", async () => {
  const { runtime, calls } = createRuntimeMock();
  const adapter = new MatrixAdapter(createConfig(), new Set(["@u1:example.org"]), runtime as never);

  adapter.onCommand(async () => "History cleared.");

  await adapter.start();
  await runtime.emitTimeline({
    room: createRoom(),
    event: createEvent({ content: { msgtype: "m.text", body: "/clear" } }),
  });

  assert.equal(calls.some((call) => call.method === "sendMessage"), true);
});

test("MatrixAdapter reports unknown matrix commands with guidance", async () => {
  const { runtime, calls } = createRuntimeMock();
  const adapter = new MatrixAdapter(createConfig(), new Set(["@u1:example.org"]), runtime as never);

  adapter.onCommand(async () => undefined);

  await adapter.start();
  await runtime.emitTimeline({
    room: createRoom(),
    event: createEvent({ content: { msgtype: "m.text", body: "/unknown" } }),
  });

  const promptCall = calls.find((call) => call.method === "sendMessage");
  const prompt = promptCall?.args[1] as Record<string, unknown>;
  assert.match(String(prompt?.body ?? ""), /Unknown command: \/unknown/);
  assert.match(String(prompt?.body ?? ""), /Use \/help or \/commands to list available commands/);
});

test("MatrixAdapter handles reaction-driven matrix actions", async () => {
  const { runtime, calls } = createRuntimeMock();
  const adapter = new MatrixAdapter(createConfig(), new Set(["@u1:example.org"]), runtime as never);

  adapter.onCommand(async () => ({
    text: "Current model: Base\nReact to this message or send `/model <number|name>`:\n1️⃣ Base [selected]\n2️⃣ Alt",
    buttons: [
      { label: "Base [selected]", action: "mdl:0" },
      { label: "Alt", action: "mdl:1" },
    ],
  }));
  adapter.onAction(async ({ data }) => ({
    text: data === "mdl:1" ? "Model changed to Alt" : "Current model: Base",
  }));

  await adapter.start();
  await runtime.emitTimeline({
    room: createRoom(),
    event: createEvent({ content: { msgtype: "m.text", body: "/model" } }),
  });
  await runtime.emitTimeline({
    room: createRoom(),
    event: createEvent({
      type: "m.reaction",
      id: "$reaction1",
      content: {
        "m.relates_to": {
          rel_type: "m.annotation",
          event_id: "$evt1",
          key: "2️⃣",
        },
      },
    }),
  });

  const sendCalls = calls.filter((call) => call.method === "sendMessage");
  assert.equal(sendCalls.length >= 2, true);
  const editPayload = sendCalls.at(-1)?.args[1] as Record<string, unknown>;
  const relation = editPayload["m.relates_to"] as Record<string, unknown>;
  const newContent = editPayload["m.new_content"] as Record<string, unknown>;

  assert.equal(relation["rel_type"], "m.replace");
  assert.equal(relation["event_id"], "$evt1");
  assert.match(String(editPayload["body"] ?? ""), /^\* /);
  assert.match(String(newContent["body"] ?? ""), /Model changed to Alt/);

  // Terminal step: the bot's seeded numbered reactions are redacted so the resolved
  // menu does not keep stale choice reactions.
  const redactCalls = calls.filter((call) => call.method === "redactEvent");
  assert.equal(redactCalls.length, 2);
});

test("MatrixAdapter sends the next menu step as a new message with fresh reactions", async () => {
  const { runtime, calls } = createRuntimeMock();
  const adapter = new MatrixAdapter(createConfig(), new Set(["@u1:example.org"]), runtime as never);

  adapter.onCommand(async () => ({
    text: "Current model: Base\n1️⃣ LiteLLM >\n2️⃣ Claude >",
    buttons: [
      { label: "LiteLLM >", action: "mdlg:0" },
      { label: "Claude >", action: "mdlg:1" },
    ],
  }));
  adapter.onAction(async () => ({
    text: "Claude\n1️⃣ Sonnet\n2️⃣ Opus\n3️⃣ Haiku\n4️⃣ < Back",
    buttons: [
      { label: "Sonnet", action: "mdl:0" },
      { label: "Opus", action: "mdl:1" },
      { label: "Haiku", action: "mdl:2" },
      { label: "< Back", action: "mdlb" },
    ],
    supersededText: "Model menu > Claude",
  }));

  await adapter.start();
  await runtime.emitTimeline({
    room: createRoom(),
    event: createEvent({ content: { msgtype: "m.text", body: "/model" } }),
  });
  const seedsBefore = calls.filter(
    (call) => call.method === "sendEvent" && (call.args[1] as string) === "m.reaction",
  ).length;
  assert.equal(seedsBefore, 2);

  await runtime.emitTimeline({
    room: createRoom(),
    event: createEvent({
      type: "m.reaction",
      id: "$reaction-nav",
      content: {
        "m.relates_to": { rel_type: "m.annotation", event_id: "$evt1", key: "2️⃣" },
      },
    }),
  });

  const sendCalls = calls.filter((call) => call.method === "sendMessage");
  // The old menu collapses to a breadcrumb edit...
  const edit = sendCalls
    .map((call) => call.args[1] as Record<string, unknown>)
    .find((payload) => (payload["m.relates_to"] as Record<string, unknown>)?.["rel_type"] === "m.replace");
  assert.ok(edit);
  assert.match(String((edit["m.new_content"] as Record<string, unknown>)["body"] ?? ""), /Model menu > Claude/);

  // ...the new step is a FRESH message (not an edit) carrying the submenu...
  const fresh = sendCalls.at(-1)?.args[1] as Record<string, unknown>;
  assert.equal((fresh["m.relates_to"] as Record<string, unknown> | undefined)?.["rel_type"], undefined);
  assert.match(String(fresh["body"] ?? ""), /Sonnet/);

  // ...with its own full set of seeded reactions (4 options) and the old seeds redacted.
  const seedsAfter = calls.filter(
    (call) => call.method === "sendEvent" && (call.args[1] as string) === "m.reaction",
  ).length;
  assert.equal(seedsAfter, seedsBefore + 4);
  assert.equal(calls.filter((call) => call.method === "redactEvent").length, 2);
});

test("MatrixAdapter handles text-reply matrix actions", async () => {
  const { runtime, calls } = createRuntimeMock();
  const adapter = new MatrixAdapter(createConfig(), new Set(["@u1:example.org"]), runtime as never);

  adapter.onCommand(async () => ({
    text: "Current model: Base\nReply with a number/name, react to this message, or send `/model <number|name>`:\n1️⃣ Base [selected]\n2️⃣ Alt",
    buttons: [
      { label: "Base [selected]", action: "mdl:0" },
      { label: "Alt", action: "mdl:1" },
    ],
  }));
  adapter.onAction(async ({ data }) => ({
    text: data === "mdl:1" ? "Model changed to Alt" : "Current model: Base",
  }));

  await adapter.start();
  await runtime.emitTimeline({
    room: createRoom(),
    event: createEvent({ id: "$menu-root", content: { msgtype: "m.text", body: "/model" } }),
  });
  await runtime.emitTimeline({
    room: createRoom(),
    event: createEvent({
      id: "$reply-select",
      content: {
        msgtype: "m.text",
        body: "2",
      },
      relation: { "m.in_reply_to": { event_id: "$evt1" } },
    }),
  });

  const sendCalls = calls.filter((call) => call.method === "sendMessage");
  assert.equal(sendCalls.length >= 2, true);
  const editPayload = sendCalls.at(-1)?.args[1] as Record<string, unknown>;
  const newContent = editPayload["m.new_content"] as Record<string, unknown>;
  assert.match(String(newContent["body"] ?? ""), /Model changed to Alt/);
});

test("MatrixAdapter handles text-reply matrix actions beyond ten options", async () => {
  const { runtime, calls } = createRuntimeMock();
  const adapter = new MatrixAdapter(createConfig(), new Set(["@u1:example.org"]), runtime as never);

  adapter.onCommand(async () => ({
    text: [
      "Choose a model",
      "Reply with a number/name, react to this message, or send `/model <number|name>`:",
      ...Array.from({ length: 12 }, (_, index) => `${index + 1}. Model ${index + 1}`),
    ].join("\n"),
    buttons: Array.from({ length: 12 }, (_, index) => ({
      label: `Model ${index + 1}${index === 11 ? " [selected]" : ""}`,
      action: `mdl:${index}`,
    })),
  }));
  adapter.onAction(async ({ data }) => ({
    text: data === "mdl:11" ? "Model changed to Model 12" : `Selected ${data}`,
  }));

  await adapter.start();
  await runtime.emitTimeline({
    room: createRoom(),
    event: createEvent({ id: "$menu-root-12", content: { msgtype: "m.text", body: "/model" } }),
  });
  await runtime.emitTimeline({
    room: createRoom(),
    event: createEvent({
      id: "$reply-select-12",
      content: {
        msgtype: "m.text",
        body: "12",
      },
      relation: { "m.in_reply_to": { event_id: "$evt1" } },
    }),
  });

  const sendCalls = calls.filter((call) => call.method === "sendMessage");
  assert.equal(sendCalls.length >= 2, true);
  const editPayload = sendCalls.at(-1)?.args[1] as Record<string, unknown>;
  const newContent = editPayload["m.new_content"] as Record<string, unknown>;
  assert.match(String(newContent["body"] ?? ""), /Model changed to Model 12/);
});

test("MatrixAdapter confirmTool sends approval prompt and returns approval decision", async () => {
  const { runtime, calls } = createRuntimeMock();
  const adapter = new MatrixAdapter(createConfig(), new Set(["@u1:example.org"]), runtime as never);
  let resolveDecision!: (decision: "allow-session") => void;
  const approvalHandler: MatrixApprovalHandler = {
    requestApproval: async () => {
      return await new Promise((resolve) => {
        resolveDecision = resolve as (decision: "allow-session") => void;
      });
    },
    cancelApproval: () => false,
    resolveAction: async () => undefined,
    persistPendingApprovals: async () => {},
    restorePendingApprovals: async () => {},
  };

  await adapter.start();
  const pendingDecision = adapter.confirmTool(
    {
      id: "apr-confirm",
      platform: "matrix",
      chatId: "!room:test",
      userId: "@u1:example.org",
      chatType: "group",
      messageId: "$evt1",
      sessionId: "matrix/group/!room:test",
      toolName: "bash",
      args: { command: "pwd" },
    },
    approvalHandler,
  );

  const promptCall = calls.find((call) => call.method === "sendMessage");
  assert.ok(promptCall);
  const prompt = promptCall?.args[1] as Record<string, unknown>;
  assert.match(String(prompt.body ?? ""), /Approval required for tool/);

  resolveDecision("allow-session");

  assert.equal(await pendingDecision, "allow-session");
});

test("MatrixAdapter confirm sends prompt and resolves on reply action", async () => {
  const { runtime, calls } = createRuntimeMock();
  const adapter = new MatrixAdapter(
    createConfig({ groups: { "!room:test": { requireMention: true } } }),
    new Set(["@u1:example.org"]),
    runtime as never,
  );

  await adapter.start();
  const pendingDecision = adapter.confirm("!room:test", "Confirm deploy?", "$evt1");
  await new Promise((resolve) => setTimeout(resolve, 0));

  const promptCall = calls.find((call) => call.method === "sendMessage");
  assert.ok(promptCall);
  const prompt = promptCall?.args[1] as Record<string, unknown>;
  assert.match(String(prompt.body ?? ""), /Confirm deploy\?/);

  await runtime.emitTimeline({
    room: createRoom({ joinedMembers: ["@bot:example.org", "@u1:example.org", "@u2:example.org"] }),
    event: createEvent({
      id: "$confirm-reply",
      content: { msgtype: "m.text", body: "1" },
      relation: { "m.in_reply_to": { event_id: "$evt1" } },
    }),
  });

  assert.equal(await pendingDecision, true);
  const sendCalls = calls.filter((call) => call.method === "sendMessage");
  const editPayload = sendCalls.at(-1)?.args[1] as Record<string, unknown>;
  const newContent = editPayload["m.new_content"] as Record<string, unknown>;
  assert.match(String(newContent?.body ?? ""), /Accepted\./);
});

test("MatrixAdapter confirm resolves false on deny reaction", async () => {
  const { runtime, calls } = createRuntimeMock();
  const adapter = new MatrixAdapter(
    createConfig({ groups: { "!room:test": { requireMention: true } } }),
    new Set(["@u1:example.org"]),
    runtime as never,
  );

  await adapter.start();
  const pendingDecision = adapter.confirm("!room:test", "Confirm delete?", "$evt1");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const promptCall = calls.find((call) => call.method === "sendMessage");
  assert.ok(promptCall);

  await runtime.emitTimeline({
    room: createRoom({ joinedMembers: ["@bot:example.org", "@u1:example.org", "@u2:example.org"] }),
    event: createEvent({
      id: "$confirm-react",
      type: "m.reaction",
      content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$evt1", key: "2️⃣" } },
    }),
  });

  assert.equal(await pendingDecision, false);
});

test("MatrixAdapter requires configured group rooms in allowlist mode", async () => {
  const { runtime } = createRuntimeMock();
  const adapter = new MatrixAdapter(
    createConfig({ groups: { "!allowed:test": { requireMention: false } } }),
    new Set<string>(),
    runtime as never,
  );
  const received: string[] = [];

  adapter.onMessage(async (message) => {
    received.push(message.text);
  });

  await adapter.start();
  await runtime.emitTimeline({
    room: createRoom({
      roomId: "!room:test",
      joinedMembers: ["@bot:example.org", "@u1:example.org", "@u2:example.org"],
    }),
    event: createEvent(),
  });

  assert.deepEqual(received, []);
});

test("MatrixAdapter supports wildcard group room config", async () => {
  const { runtime } = createRuntimeMock();
  const adapter = new MatrixAdapter(
    createConfig({ groups: { "*": { requireMention: false } } }),
    new Set<string>(),
    runtime as never,
  );
  const received: string[] = [];

  adapter.onMessage(async (message) => {
    received.push(message.text);
  });

  await adapter.start();
  await runtime.emitTimeline({
    room: createRoom({
      roomId: "!room:test",
      joinedMembers: ["@bot:example.org", "@u1:example.org", "@u2:example.org"],
    }),
    event: createEvent(),
  });

  assert.deepEqual(received, ["hello"]);
});

test("MatrixAdapter ignores hidden metadata mentions in group rooms", async () => {
  const { runtime } = createRuntimeMock();
  const adapter = new MatrixAdapter(
    createConfig({ groups: { "!room:test": { requireMention: true } } }),
    new Set<string>(),
    runtime as never,
  );
  const received: string[] = [];

  adapter.onMessage(async (message) => {
    received.push(message.text);
  });

  await adapter.start();
  await runtime.emitTimeline({
    room: createRoom({ joinedMembers: ["@bot:example.org", "@u1:example.org", "@u2:example.org"] }),
    event: createEvent({
      content: {
        msgtype: "m.text",
        body: "hello",
        "m.mentions": { user_ids: ["@bot:example.org"] },
      },
    }),
  });

  assert.deepEqual(received, []);
});

test("MatrixAdapter preserves mention prefixes in routed group messages", async () => {
  const { runtime } = createRuntimeMock();
  const adapter = new MatrixAdapter(
    createConfig({ groups: { "!room:test": { requireMention: true } } }),
    new Set<string>(),
    runtime as never,
  );
  const received: string[] = [];

  adapter.onMessage(async (message) => {
    received.push(message.text);
  });

  await adapter.start();
  await runtime.emitTimeline({
    room: createRoom({ joinedMembers: ["@bot:example.org", "@u1:example.org", "@u2:example.org"] }),
    event: createEvent({
      content: {
        msgtype: "m.text",
        body: "@bot hello",
        "m.mentions": { user_ids: ["@bot:example.org"] },
      },
    }),
  });

  assert.deepEqual(received, ["@bot hello"]);
});

test("MatrixAdapter matches room mentions via live self display name", async () => {
  const { runtime } = createRuntimeMock();
  const adapter = new MatrixAdapter(
    createConfig({ groups: { "!room:test": { requireMention: true } } }),
    new Set<string>(),
    runtime as never,
  );
  const received: string[] = [];

  adapter.onMessage(async (message) => {
    received.push(message.text);
  });

  await adapter.start();
  await runtime.emitTimeline({
    room: createRoom({ joinedMembers: ["@bot:example.org", "@u1:example.org", "@u2:example.org"] }),
    event: createEvent({
      content: {
        msgtype: "m.text",
        body: "Bot User: hello",
      },
    }),
  });

  assert.deepEqual(received, ["Bot User: hello"]);
});

test("MatrixAdapter matches formatted display-name mentions via live self display name", async () => {
  const { runtime } = createRuntimeMock();
  const adapter = new MatrixAdapter(
    createConfig({ groups: { "!room:test": { requireMention: true } } }),
    new Set<string>(),
    runtime as never,
  );
  const received: string[] = [];

  adapter.onMessage(async (message) => {
    received.push(message.text);
  });

  await adapter.start();
  await runtime.emitTimeline({
    room: createRoom({ joinedMembers: ["@bot:example.org", "@u1:example.org", "@u2:example.org"] }),
    event: createEvent({
      content: {
        msgtype: "m.text",
        body: "hello there",
        formatted_body:
          '<a href="https://matrix.to/#/%40bot%3Aexample.org">Bot User</a>: hello there',
        "m.mentions": { user_ids: ["@bot:example.org"] },
      },
    }),
  });

  assert.deepEqual(received, ["hello there"]);
});

test("MatrixAdapter handles room commands addressed to live self display name", async () => {
  const { runtime, calls } = createRuntimeMock();
  const adapter = new MatrixAdapter(
    createConfig({ groups: { "!room:test": { requireMention: true } } }),
    new Set<string>(),
    runtime as never,
  );

  adapter.onCommand(async () => "History cleared.");

  await adapter.start();
  await runtime.emitTimeline({
    room: createRoom({ joinedMembers: ["@bot:example.org", "@u1:example.org", "@u2:example.org"] }),
    event: createEvent({
      content: {
        msgtype: "m.text",
        body: "Bot User, /clear",
      },
    }),
  });

  assert.equal(calls.some((call) => call.method === "sendMessage"), true);
});

test("MatrixAdapter ignores room commands outside configured group rooms", async () => {
  const { runtime, calls } = createRuntimeMock();
  const adapter = new MatrixAdapter(
    createConfig({ groups: { "!allowed:test": { requireMention: false } } }),
    new Set<string>(),
    runtime as never,
  );

  adapter.onCommand(async () => "History cleared.");

  await adapter.start();
  await runtime.emitTimeline({
    room: createRoom({
      roomId: "!room:test",
      joinedMembers: ["@bot:example.org", "@u1:example.org", "@u2:example.org"],
    }),
    event: createEvent({ content: { msgtype: "m.text", body: "/clear" } }),
  });

  assert.equal(calls.some((call) => call.method === "sendMessage"), false);
});

test("MatrixAdapter resolves reply and thread context", async () => {
  const { runtime } = createRuntimeMock();
  const adapter = new MatrixAdapter(
    createConfig({ groups: { "!room:test": { requireMention: false } }, threadReplies: "inbound" }),
    new Set<string>(),
    runtime as never,
  );
  const received: Array<{ text: string; replyToText?: string; replyToSender?: string; threadRootText?: string }> = [];

  adapter.onMessage(async (message) => {
    received.push({
      text: message.text,
      replyToText: message.replyToText,
      replyToSender: message.replyToSender,
      threadRootText: message.threadRootText,
    });
  });

  await adapter.start();
  await runtime.emitTimeline({
    room: createRoom({ joinedMembers: ["@bot:example.org", "@u1:example.org", "@u2:example.org"] }),
    event: createEvent({
      relation: {
        rel_type: "m.thread",
        event_id: "$thread-root",
        "m.in_reply_to": { event_id: "$reply" },
      },
    }),
  });

  assert.deepEqual(received, [
    {
      text: "hello",
      replyToText: "quoted message",
      replyToSender: "@alice:example.org",
      threadRootText: "Matrix thread root from @alice:example.org:\n[matrix image attachment]",
    },
  ]);
});

test("MatrixAdapter preserves media-only messages as attachment summaries", async () => {
  const { runtime } = createRuntimeMock();
  const adapter = new MatrixAdapter(
    createConfig(),
    new Set(["@u1:example.org"]),
    runtime as never,
  );
  const received: Array<{ text: string; attachments: unknown[] }> = [];

  adapter.onMessage(async (message) => {
    received.push({ text: message.text, attachments: message.attachments });
  });

  await adapter.start();
  await runtime.emitTimeline({
    room: createRoom({ inviter: "@u1:example.org" }),
    event: createEvent({
      content: {
        msgtype: "m.image",
        body: "photo.jpg",
        filename: "photo.jpg",
        info: { mimetype: "image/jpeg", size: 42, w: 10, h: 20 },
        url: "mxc://example.org/photo",
      },
    }),
  });

  assert.equal(received[0]?.attachments.length, 1);
  assert.equal(received[0]?.text, "[matrix image attachment unavailable]");
});

test("MatrixAdapter coalesces quick multi-event attachment bursts into one logical inbound message", async () => {
  const { runtime } = createRuntimeMock();
  const adapter = new TestMatrixAdapter(
    createConfig({ groups: { "!room:test": { requireMention: false } } }),
    new Set(["@u1:example.org"]),
    runtime as never,
  );
  const received: Array<{ text: string; attachmentCount: number }> = [];

  adapter.onMessage(async (message) => {
    received.push({ text: message.text, attachmentCount: message.attachments.length });
  });

  await adapter.start();
  await runtime.emitTimeline({
    room: createRoom({ joinedMembers: ["@bot:example.org", "@u1:example.org", "@u2:example.org"] }),
    event: createEvent({
      id: "$img1",
      content: {
        msgtype: "m.image",
        body: "photo-1.jpg",
        filename: "photo-1.jpg",
        info: { mimetype: "image/jpeg", size: 42 },
        url: "mxc://example.org/photo-1",
      },
    }),
  });
  await runtime.emitTimeline({
    room: createRoom({ joinedMembers: ["@bot:example.org", "@u1:example.org", "@u2:example.org"] }),
    event: createEvent({
      id: "$img2",
      content: {
        msgtype: "m.image",
        body: "photo-2.jpg",
        filename: "photo-2.jpg",
        info: { mimetype: "image/jpeg", size: 43 },
        url: "mxc://example.org/photo-2",
      },
    }),
  });
  await waitFor(() => received.length >= 1);

  assert.equal(received.length, 1);
  assert.equal(received[0]?.attachmentCount, 2);
  assert.match(received[0]?.text ?? "", /matrix image attachment unavailable/);
});

test("MatrixAdapter rewrites trailing text bursts into media captions", async () => {
  const { runtime } = createRuntimeMock();
  const adapter = new TestMatrixAdapter(
    createConfig({ groups: { "!room:test": { requireMention: false } } }),
    new Set(["@u1:example.org"]),
    runtime as never,
  );
  const received: Array<{ text: string; attachmentCount: number }> = [];

  adapter.onMessage(async (message) => {
    received.push({ text: message.text, attachmentCount: message.attachments.length });
  });

  await adapter.start();
  await runtime.emitTimeline({
    room: createRoom({ joinedMembers: ["@bot:example.org", "@u1:example.org", "@u2:example.org"] }),
    event: createEvent({
      id: "$img-caption-base",
      content: {
        msgtype: "m.image",
        body: "photo.jpg",
        filename: "photo.jpg",
        info: { mimetype: "image/jpeg", size: 42 },
        url: "mxc://example.org/photo-caption-base",
      },
    }),
  });
  await runtime.emitTimeline({
    room: createRoom({ joinedMembers: ["@bot:example.org", "@u1:example.org", "@u2:example.org"] }),
    event: createEvent({
      id: "$img-caption-text",
      content: { msgtype: "m.text", body: "look at this" },
    }),
  });
  await waitFor(() => received.length >= 1);

  assert.equal(received.length, 1);
  assert.equal(received[0]?.attachmentCount, 1);
  assert.equal(received[0]?.text, "look at this\n\n[matrix image attachment unavailable]");
});

test("MatrixAdapter rewrites short leading text bursts into media captions", async () => {
  const { runtime } = createRuntimeMock();
  const adapter = new TestMatrixAdapter(
    createConfig({ groups: { "!room:test": { requireMention: false } } }),
    new Set(["@u1:example.org"]),
    runtime as never,
  );
  const received: Array<{ text: string; attachmentCount: number }> = [];

  adapter.onMessage(async (message) => {
    received.push({ text: message.text, attachmentCount: message.attachments.length });
  });

  await adapter.start();
  await runtime.emitTimeline({
    room: createRoom({ joinedMembers: ["@bot:example.org", "@u1:example.org", "@u2:example.org"] }),
    event: createEvent({
      id: "$lead-caption-text",
      content: { msgtype: "m.text", body: "look at this" },
    }),
  });
  await runtime.emitTimeline({
    room: createRoom({ joinedMembers: ["@bot:example.org", "@u1:example.org", "@u2:example.org"] }),
    event: createEvent({
      id: "$lead-caption-image",
      content: {
        msgtype: "m.image",
        body: "photo.jpg",
        filename: "photo.jpg",
        info: { mimetype: "image/jpeg", size: 42 },
      url: "mxc://example.org/photo-leading-caption",
      },
    }),
  });
  await waitFor(() => received.length >= 1);

  assert.equal(received.length, 1);
  assert.equal(received[0]?.attachmentCount, 1);
  assert.equal(received[0]?.text, "look at this\n\n[matrix image attachment unavailable]");
});

test("MatrixAdapter coalesces short room-root split turns that arrive quickly", async () => {
  class TestMatrixAdapter extends MatrixAdapter {
    protected override bufferedIngressDelayForMessage(message: import("../src/channels/types.ts").UnifiedMessage): number {
      return message.text.trim().length > 0 && message.text.length < 160 ? 25 : super.bufferedIngressDelayForMessage(message);
    }
  }
  const { runtime } = createRuntimeMock();
  const adapter = new TestMatrixAdapter(
    createConfig({ groups: { "!room:test": { requireMention: false } } }),
    new Set(["@u1:example.org"]),
    runtime as never,
  );
  const received: string[] = [];

  adapter.onMessage(async (message) => {
    received.push(message.text);
  });

  await adapter.start();
  await runtime.emitTimeline({
    room: createRoom({ joinedMembers: ["@bot:example.org", "@u1:example.org", "@u2:example.org"] }),
    event: createEvent({ id: "$short-frag-1", content: { msgtype: "m.text", body: "part one" } }),
  });
  await runtime.emitTimeline({
    room: createRoom({ joinedMembers: ["@bot:example.org", "@u1:example.org", "@u2:example.org"] }),
    event: createEvent({ id: "$short-frag-2", content: { msgtype: "m.text", body: "part two" } }),
  });
  await waitFor(() => received.length >= 1);

  assert.deepEqual(received, ["part one\npart two"]);
});

test("MatrixAdapter keeps real media captions but strips filename-only bodies", async () => {
  const { runtime } = createRuntimeMock();
  const adapter = new MatrixAdapter(createConfig(), new Set(["@u1:example.org"]), runtime as never);
  const received: string[] = [];

  adapter.onMessage(async (message) => {
    received.push(message.text);
  });

  await adapter.start();
  await runtime.emitTimeline({
    room: createRoom({ inviter: "@u1:example.org" }),
    event: createEvent({
      id: "$captioned-image",
      content: {
        msgtype: "m.image",
        body: "look at this",
        filename: "photo.jpg",
        info: { mimetype: "image/jpeg", size: 42 },
        url: "mxc://example.org/captioned",
      },
    }),
  });
  await runtime.emitTimeline({
    room: createRoom({ inviter: "@u1:example.org" }),
    event: createEvent({
      id: "$filename-only-image",
      content: {
        msgtype: "m.image",
        body: "photo.jpg",
        filename: "photo.jpg",
        info: { mimetype: "image/jpeg", size: 42 },
        url: "mxc://example.org/filename-only",
      },
    }),
  });

  assert.match(received[0] ?? "", /^look at this\n\n\[matrix image attachment unavailable\]$/);
  assert.equal(received[1], "[matrix image attachment unavailable]");
});

test("MatrixAdapter coalesces fragmented group text bursts into one logical inbound message", async () => {
  const { runtime } = createRuntimeMock();
  const adapter = new TestMatrixAdapter(
    createConfig({ groups: { "!room:test": { requireMention: false } } }),
    new Set(["@u1:example.org"]),
    runtime as never,
  );
  const received: string[] = [];

  adapter.onMessage(async (message) => {
    received.push(message.text);
  });

  await adapter.start();
  await runtime.emitTimeline({
    room: createRoom({ joinedMembers: ["@bot:example.org", "@u1:example.org", "@u2:example.org"] }),
    event: createEvent({
      id: "$frag1",
      content: { msgtype: "m.text", body: "a".repeat(180) },
    }),
  });
  await runtime.emitTimeline({
    room: createRoom({ joinedMembers: ["@bot:example.org", "@u1:example.org", "@u2:example.org"] }),
    event: createEvent({
      id: "$frag2",
      content: { msgtype: "m.text", body: "b".repeat(180) },
    }),
  });
  await waitFor(() => received.length >= 1);

  assert.deepEqual(received, [`${"a".repeat(180)}\n${"b".repeat(180)}`]);
});

test("MatrixAdapter coalesces threaded split turns separately from the room root", async () => {
  const { runtime } = createRuntimeMock();
  const adapter = new TestMatrixAdapter(
    createConfig({ groups: { "!room:test": { requireMention: false } }, threadReplies: "inbound" }),
    new Set(["@u1:example.org"]),
    runtime as never,
  );
  const received: Array<{ text: string; threadId?: string }> = [];

  adapter.onMessage(async (message) => {
    received.push({ text: message.text, threadId: message.threadId });
  });

  await adapter.start();
  await runtime.emitTimeline({
    room: createRoom({ joinedMembers: ["@bot:example.org", "@u1:example.org", "@u2:example.org"] }),
    event: createEvent({
      id: "$thread-frag-1",
      content: { msgtype: "m.text", body: "part one" },
      relation: { rel_type: "m.thread", event_id: "$thread-root", "m.in_reply_to": { event_id: "$thread-root" } },
      thread: { id: "$thread-root" },
    }),
  });
  await runtime.emitTimeline({
    room: createRoom({ joinedMembers: ["@bot:example.org", "@u1:example.org", "@u2:example.org"] }),
    event: createEvent({
      id: "$thread-frag-2",
      content: { msgtype: "m.text", body: "part two" },
      relation: { rel_type: "m.thread", event_id: "$thread-root", "m.in_reply_to": { event_id: "$thread-root" } },
      thread: { id: "$thread-root" },
    }),
  });
  await runtime.emitTimeline({
    room: createRoom({ joinedMembers: ["@bot:example.org", "@u1:example.org", "@u2:example.org"] }),
    event: createEvent({ id: "$room-root-msg", content: { msgtype: "m.text", body: "root text" } }),
  });
  await waitFor(() => received.length >= 2);

  assert.deepEqual(received, [
    { text: "root text", threadId: undefined },
    { text: "part one\npart two", threadId: "$thread-root" },
  ]);
});

test("MatrixAdapter uses longer buffering for near-limit split chunks", async () => {
  class TestMatrixAdapter extends MatrixAdapter {
    public bufferedDelayFor(text: string): number {
      return this.bufferedIngressDelayMs(text);
    }
  }
  const { runtime } = createRuntimeMock();
  const adapter = new TestMatrixAdapter(createConfig(), new Set(["@u1:example.org"]), runtime as never);

  assert.equal(adapter.bufferedDelayFor("short"), 600);
  assert.equal(adapter.bufferedDelayFor("x".repeat(3900)), 2000);
});

test("MatrixAdapter marks bridge-style inbound messages as forwarded", async () => {
  const { runtime } = createRuntimeMock();
  const adapter = new MatrixAdapter(
    createConfig({ groups: { "!room:test": { requireMention: false } } }),
    new Set(["@_telegram_123:example.org"]),
    runtime as never,
  );
  const received: boolean[] = [];

  adapter.onMessage(async (message) => {
    received.push(message.isForwarded);
  });

  await adapter.start();
  await runtime.emitTimeline({
    room: createRoom({ inviter: "@_telegram_123:example.org", joinedMembers: ["@bot:example.org", "@_telegram_123:example.org"] }),
    event: createEvent({
      id: "$fwd1",
      sender: "@_telegram_123:example.org",
      content: { msgtype: "m.text", body: "bridged hello" },
    }),
  });

  assert.deepEqual(received, [true]);
});

test("MatrixAdapter marks double-puppet metadata messages as forwarded", async () => {
  const { runtime } = createRuntimeMock();
  const adapter = new MatrixAdapter(
    createConfig({ groups: { "!room:test": { requireMention: false } } }),
    new Set(["@u1:example.org"]),
    runtime as never,
  );
  const received: boolean[] = [];

  adapter.onMessage(async (message) => {
    received.push(message.isForwarded);
  });

  await adapter.start();
  await runtime.emitTimeline({
    room: createRoom({ inviter: "@u1:example.org", joinedMembers: ["@bot:example.org", "@u1:example.org"] }),
    event: createEvent({
      id: "$fwd-double-puppet",
      sender: "@u1:example.org",
      content: { msgtype: "m.text", body: "bridged hello", "fi.mau.double_puppet_source": "telegram" },
    }),
  });

  assert.deepEqual(received, [true]);
});

test("MatrixAdapter does not mark ordinary messages as forwarded", async () => {
  const { runtime } = createRuntimeMock();
  const adapter = new MatrixAdapter(
    createConfig({ groups: { "!room:test": { requireMention: false } } }),
    new Set(["@u1:example.org"]),
    runtime as never,
  );
  const received: boolean[] = [];

  adapter.onMessage(async (message) => {
    received.push(message.isForwarded);
  });

  await adapter.start();
  await runtime.emitTimeline({
    room: createRoom({ inviter: "@u1:example.org", joinedMembers: ["@bot:example.org", "@u1:example.org"] }),
    event: createEvent({
      id: "$not-forwarded",
      sender: "@u1:example.org",
      content: { msgtype: "m.text", body: "plain hello" },
    }),
  });

  assert.deepEqual(received, [false]);
});

test("MatrixAdapter strips Matrix reply fallback from normalized text", async () => {
  const { runtime } = createRuntimeMock();
  const adapter = new MatrixAdapter(
    createConfig({ groups: { "!room:test": { requireMention: false } } }),
    new Set(["@u1:example.org"]),
    runtime as never,
  );
  const received: Array<{ text: string; replyToText?: string }> = [];

  adapter.onMessage(async (message) => {
    received.push({ text: message.text, replyToText: message.replyToText });
  });

  await adapter.start();
  await runtime.emitTimeline({
    room: createRoom({ joinedMembers: ["@bot:example.org", "@u1:example.org", "@u2:example.org"] }),
    event: createEvent({
      id: "$reply-fallback",
      content: {
        msgtype: "m.text",
        body: "> <@alice:example.org> quoted message\n\nactual reply body",
      },
      relation: { "m.in_reply_to": { event_id: "$reply" } },
    }),
  });

  assert.deepEqual(received, [{ text: "actual reply body", replyToText: "quoted message" }]);
});

test("MatrixAdapter does not coalesce fragmented group bursts across different reply targets", async () => {
  const { runtime } = createRuntimeMock();
  const adapter = new TestMatrixAdapter(
    createConfig({ groups: { "!room:test": { requireMention: false } } }),
    new Set(["@u1:example.org"]),
    runtime as never,
  );
  const received: Array<{ text: string; replyToId?: string }> = [];

  adapter.onMessage(async (message) => {
    received.push({ text: message.text, replyToId: message.replyToId });
  });

  await adapter.start();
  await runtime.emitTimeline({
    room: createRoom({ joinedMembers: ["@bot:example.org", "@u1:example.org", "@u2:example.org"] }),
    event: createEvent({
      id: "$frag-reply-1",
      content: { msgtype: "m.text", body: "a".repeat(180) },
      relation: { "m.in_reply_to": { event_id: "$reply-a" } },
    }),
  });
  await runtime.emitTimeline({
    room: createRoom({ joinedMembers: ["@bot:example.org", "@u1:example.org", "@u2:example.org"] }),
    event: createEvent({
      id: "$frag-reply-2",
      content: { msgtype: "m.text", body: "b".repeat(180) },
      relation: { "m.in_reply_to": { event_id: "$reply-b" } },
    }),
  });
  await waitFor(() => received.length >= 2);

  assert.equal(received.length, 2);
  assert.equal(received[0]?.replyToId, "$reply-a");
  assert.equal(received[1]?.replyToId, "$reply-b");
});

test("MatrixAdapter integrates router agent bridge and streamer for a Matrix flow", async () => {
  const { runtime, calls } = createRuntimeMock();
  const adapter = new TestMatrixAdapter(
    createConfig({ groups: { "!room:test": { requireMention: false } } }),
    new Set(["@u1:example.org"]),
    runtime as never,
  );
  const sessionManager = new SessionManager();
  const toolRegistry = new ToolRegistry();
  const skillRegistry = new SkillRegistry();
  const agent = new AgentBridge(
    {
      whitelist: ["@u1:example.org"],
      blacklist: [],
      channels: {},
      llm: { provider: "x", baseUrl: "https://example.com", model: "matrix-test-model" },
      agents: {},
    },
    toolRegistry,
    skillRegistry,
  );
  const router = new MessageRouter(sessionManager, agent);

  // Mock the agent streaming path so the test verifies adapter-router-streamer
  // wiring without depending on the real LLM fetch implementation.
  const originalHandleMessageStreaming = agent.handleMessageStreaming.bind(agent);
  agent.handleMessageStreaming = async (_message, _session, onToken, onToolUse) => {
    await onToken("hello");
    await onToken(" world");
    if (onToolUse) await onToolUse([{ name: "bash", arguments: { command: "ls" }, durationMs: 10 }], true);
    return "hello world";
  };

  adapter.onMessage(async (msg) => {
    const streamer = adapter.createStreamer(msg);
    try {
      const response = await router.route(msg, {
        onToken: (token) => streamer.push(token),
        onToolUse: (tools, verbose) => streamer.appendToolUse(tools, verbose),
      });
      await streamer.finish(response?.text);
    } catch (err) {
      await streamer.abort();
      throw err;
    }
  });

  try {
    await adapter.start();
    await runtime.emitTimeline({
      room: createRoom(),
      event: createEvent({ id: "$stream-flow", content: { msgtype: "m.text", body: "hi there" } }),
    });

    // The full round trip runs behind a 25ms buffered-ingress timer, so a fixed sleep was a bet
    // on machine speed. Wait for the edit that ends the stream instead.
    await waitFor(() =>
      calls.filter((c) => c.method === "sendMessage").length >= 2
      && calls.some((c) => c.method === "sendMessage"
        && (c.args[1] as Record<string, unknown>)?.["m.new_content"] !== undefined));

    const sendCalls = calls.filter((call) => call.method === "sendMessage");
    assert.ok(sendCalls.length >= 2);
    const firstContent = sendCalls[0]?.args[1] as Record<string, unknown>;
    assert.equal(firstContent["body"], "hello");
    const finalEdit = sendCalls.find((c) =>
      (c.args[1] as Record<string, unknown>)?.["m.new_content"] !== undefined,
    );
    assert.ok(finalEdit, "expected at least one edit with m.new_content");
    assert.equal(
      ((finalEdit!.args[1] as Record<string, unknown>)["m.new_content"] as Record<string, unknown>)?.["body"],
      "hello world",
    );
  } finally {
    agent.handleMessageStreaming = originalHandleMessageStreaming;
  }
});

test("MatrixAdapter restores pending action menus after restart", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "my-claw-matrix-adapter-"));
  try {
    const firstRuntime = createRuntimeMock({ storageRootDir: tempDir });
    const firstAdapter = new MatrixAdapter(
      createConfig({ groups: { "!room:test": { requireMention: false } } }),
      new Set(["@u1:example.org"]),
      firstRuntime.runtime as never,
    );

    firstAdapter.onCommand(async () => ({
      text: "Current model: Base\nReply with a number/name, react to this message, or send `/model <number|name>`:\n1️⃣ Base [selected]\n2️⃣ Alt",
      buttons: [
        { label: "Base [selected]", action: "mdl:0" },
        { label: "Alt", action: "mdl:1" },
      ],
    }));
    firstAdapter.onAction(async ({ data }) => ({
      text: data === "mdl:1" ? "Model changed to Alt" : "Current model: Base",
    }));

    await firstAdapter.start();
    await firstRuntime.runtime.emitTimeline({
      room: createRoom(),
      event: createEvent({ id: "$menu-root-restart", content: { msgtype: "m.text", body: "/model" } }),
    });
    await firstAdapter.stop();

    const secondRuntime = createRuntimeMock({ storageRootDir: tempDir });
    const secondAdapter = new MatrixAdapter(
      createConfig({ groups: { "!room:test": { requireMention: false } } }),
      new Set(["@u1:example.org"]),
      secondRuntime.runtime as never,
    );

    secondAdapter.onAction(async ({ data }) => ({
      text: data === "mdl:1" ? "Model changed to Alt" : "Current model: Base",
    }));

    await secondAdapter.start();
    await secondRuntime.runtime.emitTimeline({
      room: createRoom(),
      event: createEvent({
        id: "$reply-after-restart",
        content: { msgtype: "m.text", body: "2" },
        relation: { "m.in_reply_to": { event_id: "$evt1" } },
      }),
    });

    const sendCalls = secondRuntime.calls.filter((call) => call.method === "sendMessage");
    const edited = sendCalls.at(-1)?.args[1] as Record<string, unknown>;
    assert.match(String((edited["m.new_content"] as Record<string, unknown>)?.["body"] ?? ""), /Model changed to Alt/);
    await secondAdapter.stop();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("MatrixAdapter restores generic confirms after restart as expired prompts", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "my-claw-matrix-confirm-"));
  try {
    const firstRuntime = createRuntimeMock({ storageRootDir: tempDir });
    const firstAdapter = new MatrixAdapter(createConfig(), new Set(["@u1:example.org"]), firstRuntime.runtime as never);

    await firstAdapter.start();
    void firstAdapter.confirm("!room:test", "Confirm restart?", "$evt1");
    await new Promise((resolve) => setTimeout(resolve, 0));
    await firstAdapter.stop();

    const secondRuntime = createRuntimeMock({ storageRootDir: tempDir });
    const secondAdapter = new MatrixAdapter(createConfig(), new Set(["@u1:example.org"]), secondRuntime.runtime as never);

    await secondAdapter.start();
    await secondRuntime.runtime.emitTimeline({
      room: createRoom(),
      event: createEvent({
        id: "$confirm-after-restart",
        type: "m.reaction",
        content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$evt1", key: "1️⃣" } },
      }),
    });

    const sendCalls = secondRuntime.calls.filter((call) => call.method === "sendMessage");
    const replyPayload = sendCalls.at(-1)?.args[1] as Record<string, unknown>;
    assert.match(String(replyPayload?.body ?? ""), /expired or already resolved/i);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("MatrixAdapter aborts plain media fetches that exceed timeout", async () => {
  const { runtime } = createRuntimeMock();
  class TestMatrixAdapter extends MatrixAdapter {
    protected override mediaDownloadTimeoutMs(): number {
      return 5;
    }
  }
  const adapter = new TestMatrixAdapter(createConfig(), new Set(["@u1:example.org"]), runtime as never);
  const fetchMock = mockFetch(async (_input?: string | URL | Request, init?: RequestInit) => {
    await new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
    return new Response() as never;
  });

  try {
    await assert.rejects(
      adapter.send("!room:test", {
        text: "",
        attachments: [{ type: "file", url: "https://example.com/slow.bin", filename: "slow.bin" }],
      }),
    );
  } finally {
    fetchMock.restore();
  }
});

test("MatrixAdapter drops encrypted events when crypto is unavailable without routing them", async () => {
  const { runtime } = createRuntimeMock({ encryptionReady: false });
  const adapter = new MatrixAdapter(createConfig(), new Set(["@u1:example.org"]), runtime as never);
  const received: string[] = [];

  adapter.onMessage(async (message) => {
    received.push(message.text);
  });

  await adapter.start();
  await runtime.emitTimeline({
    room: createRoom({ joinedMembers: ["@bot:example.org", "@u1:example.org", "@u2:example.org"] }),
    event: createEvent({ id: "$enc1", type: "m.room.encrypted", content: { ciphertext: "abc" } }),
  });

  assert.deepEqual(received, []);
});

test("MatrixAdapter decrypts encrypted media attachments when crypto is available", async () => {
  const { runtime } = createRuntimeMock();
  const adapter = new MatrixAdapter(createConfig(), new Set(["@u1:example.org"]), runtime as never);
  const received: Array<{ attachments: Array<{ path?: string; summaryText?: string }> }> = [];

  adapter.onMessage(async (message) => {
    received.push({ attachments: message.attachments });
  });

  await adapter.start();
  await runtime.emitTimeline({
    room: createRoom({ inviter: "@u1:example.org" }),
    event: createEvent({
      content: {
        msgtype: "m.file",
        body: "secret.pdf",
        filename: "secret.pdf",
        info: { mimetype: "application/pdf", size: 20 },
        file: {
          url: "mxc://example.org/encrypted",
          key: { kty: "oct" },
          iv: "iv",
          hashes: { sha256: "hash" },
          v: "v2",
        },
      },
    }),
  });

  assert.equal(received[0]?.attachments.length, 1);
  assert.equal(typeof received[0]?.attachments[0]?.path, "string");
});

test("MatrixAdapter uploads encrypted media in encrypted rooms", async () => {
  const { runtime, calls } = createRuntimeMock();
  runtime.setEncryptedRooms(["!room:test"]);
  const adapter = new MatrixAdapter(
    createConfig({ encryption: true }),
    new Set(["@u1:example.org"]),
    runtime as never,
  );

  const tmpDir = await mkdtemp(join(tmpdir(), "matrix-enc-test-"));
  runtimeTempDirs.add(tmpDir);
  const tempPath = join(tmpDir, "matrix-encrypted-upload.txt");
  await writeFile(tempPath, "hello encrypted world");

  try {
    await adapter.send("!room:test", {
      text: "",
      attachments: [{ type: "file", path: tempPath, filename: "matrix-encrypted-upload.txt" }],
    });

    const uploadCall = calls.find((call) => call.method === "uploadContent");
    assert.ok(uploadCall);
    const uploadBody = uploadCall?.args[0] as Buffer;
    assert.match(uploadBody.toString("utf8"), /^encrypted:/);
    const sendCall = calls.filter((call) => call.method === "sendMessage").at(-1);
    const content = sendCall?.args[1] as Record<string, unknown>;
    assert.equal(typeof content.file, "object");
    assert.equal(content.url, undefined);
  } finally {
    runtimeTempDirs.delete(tmpDir);
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("MatrixAdapter includes recent room history when configured", async () => {
  const { runtime } = createRuntimeMock();
  const adapter = new MatrixAdapter(
    createConfig({ historyLimit: 2, groups: { "!room:test": { requireMention: true } } }),
    new Set<string>(),
    runtime as never,
  );
  const received: Array<{ roomContext?: string }> = [];

  adapter.onMessage(async (message) => {
    received.push({ roomContext: message.roomContext });
  });

  await adapter.start();
  await runtime.emitTimeline({
    room: createRoom({ joinedMembers: ["@bot:example.org", "@u1:example.org", "@u2:example.org"] }),
    event: createEvent({ id: "$old3", sender: "@u1:example.org", content: { msgtype: "m.text", body: "older one" } }),
  });
  await runtime.emitTimeline({
    room: createRoom({ joinedMembers: ["@bot:example.org", "@u1:example.org", "@u2:example.org"] }),
    event: createEvent({ id: "$old4", sender: "@u1:example.org", content: { msgtype: "m.text", body: "older two" } }),
  });
  await runtime.emitTimeline({
    room: createRoom({ joinedMembers: ["@bot:example.org", "@u1:example.org", "@u2:example.org"] }),
    event: createEvent({
      id: "$trigger1",
      content: {
        msgtype: "m.text",
        body: "@bot hello",
        "m.mentions": { user_ids: ["@bot:example.org"] },
      },
    }),
  });

  assert.match(received[0]?.roomContext ?? "", /Recent Room Context/);
  assert.match(received[0]?.roomContext ?? "", /older one/);
  assert.match(received[0]?.roomContext ?? "", /older two/);
});

test("MatrixAdapter only includes pending non-trigger history in room context", async () => {
  const { runtime } = createRuntimeMock();
  const adapter = new MatrixAdapter(
    createConfig({ historyLimit: 2, groups: { "!room:test": { requireMention: true } } }),
    new Set<string>(),
    runtime as never,
  );
  const received: Array<{ text: string; roomContext?: string }> = [];

  adapter.onMessage(async (message) => {
    received.push({ text: message.text, roomContext: message.roomContext });
  });

  await adapter.start();
  await runtime.emitTimeline({
    room: createRoom({ joinedMembers: ["@bot:example.org", "@u1:example.org", "@u2:example.org"] }),
    event: createEvent({ id: "$p1", sender: "@u1:example.org", content: { msgtype: "m.text", body: "pending one" } }),
  });
  await runtime.emitTimeline({
    room: createRoom({ joinedMembers: ["@bot:example.org", "@u1:example.org", "@u2:example.org"] }),
    event: createEvent({
      id: "$t1",
      content: {
        msgtype: "m.text",
        body: "@bot first trigger",
        "m.mentions": { user_ids: ["@bot:example.org"] },
      },
    }),
  });
  await runtime.emitTimeline({
    room: createRoom({ joinedMembers: ["@bot:example.org", "@u1:example.org", "@u2:example.org"] }),
    event: createEvent({
      id: "$t2",
      content: {
        msgtype: "m.text",
        body: "@bot second trigger",
        "m.mentions": { user_ids: ["@bot:example.org"] },
      },
    }),
  });

  assert.match(received[0]?.roomContext ?? "", /pending one/);
  assert.equal(received[1]?.roomContext, undefined);
});

test("MatrixAdapter omits blocked room history when contextVisibility is allowlist", async () => {
  const { runtime } = createRuntimeMock();
  const adapter = new MatrixAdapter(
    createConfig({
      historyLimit: 2,
      contextVisibility: "allowlist",
      groupAllowFrom: ["@u1:example.org"],
      groups: { "!room:test": { requireMention: false } },
    }),
    new Set<string>(),
    runtime as never,
  );
  const received: Array<{ roomContext?: string }> = [];

  adapter.onMessage(async (message) => {
    received.push({ roomContext: message.roomContext });
  });

  await adapter.start();
  await runtime.emitTimeline({
    room: createRoom({ joinedMembers: ["@bot:example.org", "@u1:example.org", "@u2:example.org"] }),
    event: createEvent({ id: "$old5", sender: "@u2:example.org", content: { msgtype: "m.text", body: "blocked history" } }),
  });
  await runtime.emitTimeline({
    room: createRoom({ joinedMembers: ["@bot:example.org", "@u1:example.org", "@u2:example.org"] }),
    event: createEvent({
      content: {
        msgtype: "m.text",
        body: "hello",
      },
    }),
  });

  assert.equal(received[0]?.roomContext, undefined);
});

test("MatrixAdapter keeps whitelisted sender context when contextVisibility is allowlist", async () => {
  const { runtime } = createRuntimeMock();
  const adapter = new MatrixAdapter(
    createConfig({
      historyLimit: 2,
      contextVisibility: "allowlist",
      groupAllowFrom: ["@u1:example.org"],
      groups: { "!room:test": { requireMention: true } },
    }),
    new Set(["@u2:example.org"]),
    runtime as never,
  );
  const received: Array<{ roomContext?: string }> = [];

  adapter.onMessage(async (message) => {
    received.push({ roomContext: message.roomContext });
  });

  await adapter.start();
  await runtime.emitTimeline({
    room: createRoom({ joinedMembers: ["@bot:example.org", "@u1:example.org", "@u2:example.org"] }),
    event: createEvent({ id: "$old-whitelist", sender: "@u2:example.org", content: { msgtype: "m.text", body: "whitelist history" } }),
  });
  await runtime.emitTimeline({
    room: createRoom({ joinedMembers: ["@bot:example.org", "@u1:example.org", "@u2:example.org"] }),
    event: createEvent({ content: { msgtype: "m.text", body: "@bot hello", "m.mentions": { user_ids: ["@bot:example.org"] } } }),
  });

  assert.match(received[0]?.roomContext ?? "", /whitelist history/);
});

test("MatrixAdapter preview respects replyToMode off", async () => {
  const { runtime, calls } = createRuntimeMock();
  const adapter = new MatrixAdapter(
    createConfig({ replyToMode: "off", groups: { "!room:test": { requireMention: false } } }),
    new Set(["@u1:example.org"]),
    runtime as never,
  );

  await adapter.send("!room:test", { text: "warmup" });
  const streamer = adapter.createStreamer({
    id: "$incoming",
    platform: "matrix",
    userId: "@u1:example.org",
    chatId: "!room:test",
    chatType: "group",
    text: "hello",
    attachments: [],
    isForwarded: false,
    raw: {},
  });
  await streamer.push("preview");

  const lastCall = calls.filter((call) => call.method === "sendMessage").at(-1)?.args[1] as
    | Record<string, unknown>
    | undefined;
  assert.equal(Boolean(lastCall?.["m.relates_to"]), false);
});

test("MatrixAdapter keeps explicit reply quote when contextVisibility is allowlist_quote", async () => {
  const { runtime } = createRuntimeMock();
  const adapter = new MatrixAdapter(
    createConfig({
      contextVisibility: "allowlist_quote",
      groupAllowFrom: ["@u1:example.org"],
      groups: { "!room:test": { requireMention: false } },
    }),
    new Set<string>(),
    runtime as never,
  );
  const received: Array<{ replyToText?: string; replyToSender?: string; roomContext?: string }> = [];

  adapter.onMessage(async (message) => {
    received.push({
      replyToText: message.replyToText,
      replyToSender: message.replyToSender,
      roomContext: message.roomContext,
    });
  });

  await adapter.start();
  await runtime.emitTimeline({
    room: createRoom({ joinedMembers: ["@bot:example.org", "@u1:example.org", "@u2:example.org"] }),
    event: createEvent({ relation: { "m.in_reply_to": { event_id: "$reply" } } }),
  });

  assert.equal(received[0]?.replyToText, "quoted message");
  assert.equal(received[0]?.replyToSender, "@alice:example.org");
  assert.equal(received[0]?.roomContext, undefined);
});

test("MatrixAdapter omits blocked reply quote when contextVisibility is allowlist", async () => {
  const { runtime } = createRuntimeMock();
  const adapter = new MatrixAdapter(
    createConfig({
      contextVisibility: "allowlist",
      groupAllowFrom: ["@u1:example.org"],
      groups: { "!room:test": { requireMention: false } },
    }),
    new Set<string>(),
    runtime as never,
  );
  const received: Array<{ replyToText?: string; replyToSender?: string }> = [];

  adapter.onMessage(async (message) => {
    received.push({ replyToText: message.replyToText, replyToSender: message.replyToSender });
  });

  await adapter.start();
  await runtime.emitTimeline({
    room: createRoom({ joinedMembers: ["@bot:example.org", "@u1:example.org", "@u2:example.org"] }),
    event: createEvent({ relation: { "m.in_reply_to": { event_id: "$reply" } } }),
  });

  assert.equal(received[0]?.replyToText, undefined);
  assert.equal(received[0]?.replyToSender, undefined);
});

test("MatrixAdapter blocks bot senders when allowBots is off", async () => {
  const { runtime } = createRuntimeMock();
  const adapter = new MatrixAdapter(
    createConfig({
      allowBots: false,
      groupAllowFrom: ["@helperbot:example.org"],
      groups: { "!room:test": { requireMention: false } },
    }),
    new Set<string>(),
    runtime as never,
  );
  const received: string[] = [];

  adapter.onMessage(async (message) => {
    received.push(message.text);
  });

  await adapter.start();
  await runtime.emitTimeline({
    room: createRoom({ joinedMembers: ["@bot:example.org", "@helperbot:example.org", "@u1:example.org"] }),
    event: createEvent({ sender: "@helperbot:example.org" }),
  });

  assert.deepEqual(received, []);
});

test('MatrixAdapter allows configured bot senders in groups when allowBots is "mentions" and bot is mentioned', async () => {
  const { runtime } = createRuntimeMock();
  const adapter = new MatrixAdapter(
    createConfig({
      allowBots: "mentions",
      groupAllowFrom: ["@helperbot:example.org"],
      groups: { "!room:test": { requireMention: false } },
    }),
    new Set<string>(),
    runtime as never,
  );
  const received: string[] = [];

  adapter.onMessage(async (message) => {
    received.push(message.text);
  });

  await adapter.start();
  await runtime.emitTimeline({
    room: createRoom({ joinedMembers: ["@bot:example.org", "@helperbot:example.org", "@u1:example.org"] }),
    event: createEvent({
      sender: "@helperbot:example.org",
      content: {
        msgtype: "m.text",
        body: "@bot hello",
        "m.mentions": { user_ids: ["@bot:example.org"] },
      },
    }),
  });

  assert.deepEqual(received, ["@bot hello"]);
});

test('MatrixAdapter blocks configured bot senders in groups when allowBots is "mentions" without mention', async () => {
  const { runtime } = createRuntimeMock();
  const adapter = new MatrixAdapter(
    createConfig({
      allowBots: "mentions",
      groupAllowFrom: ["@helperbot:example.org"],
      groups: { "!room:test": { requireMention: false } },
    }),
    new Set<string>(),
    runtime as never,
  );
  const received: string[] = [];

  adapter.onMessage(async (message) => {
    received.push(message.text);
  });

  await adapter.start();
  await runtime.emitTimeline({
    room: createRoom({ joinedMembers: ["@bot:example.org", "@helperbot:example.org", "@u1:example.org"] }),
    event: createEvent({ sender: "@helperbot:example.org", content: { msgtype: "m.text", body: "hello" } }),
  });

  assert.deepEqual(received, []);
});

test("MatrixAdapter does not treat unconfigured users as bots when allowBots is off", async () => {
  const { runtime } = createRuntimeMock();
  const adapter = new MatrixAdapter(
    createConfig({
      allowBots: false,
      groupAllowFrom: ["@u1:example.org"],
      groups: { "!room:test": { requireMention: false } },
      botUserIds: ["@otherbot:example.org"],
    }),
    new Set<string>(),
    runtime as never,
  );
  const received: string[] = [];

  adapter.onMessage(async (message) => {
    received.push(message.text);
  });

  await adapter.start();
  await runtime.emitTimeline({
    room: createRoom({ joinedMembers: ["@bot:example.org", "@helperbot:example.org", "@u1:example.org"] }),
    event: createEvent({ sender: "@u1:example.org" }),
  });

  assert.deepEqual(received, ["hello"]);
});

test("MatrixAdapter send chunks long text and honors replyToMode first", async () => {
  const { runtime, calls } = createRuntimeMock();
  const adapter = new MatrixAdapter(
    createConfig({ replyToMode: "first", textChunkLimit: 5 }),
    new Set(["@u1:example.org"]),
    runtime as never,
  );

  await adapter.send("!room:test", { text: "hello world again", replyToId: "$reply" });

  const sendCalls = calls.filter((call) => call.method === "sendMessage");
  assert.equal(sendCalls.length >= 3, true);
  const firstRelates = sendCalls[0]?.args[1] as Record<string, unknown>;
  const secondRelates = sendCalls[1]?.args[1] as Record<string, unknown>;
  assert.equal(Boolean(firstRelates["m.relates_to"]), true);
  assert.equal(Boolean(secondRelates["m.relates_to"]), false);
});

test("MatrixAdapter send keeps reply relation on all chunks when replyToMode is all", async () => {
  const { runtime, calls } = createRuntimeMock();
  const adapter = new MatrixAdapter(
    createConfig({ replyToMode: "all", textChunkLimit: 5 }),
    new Set(["@u1:example.org"]),
    runtime as never,
  );

  await adapter.send("!room:test", { text: "hello world again", replyToId: "$reply" });

  const sendCalls = calls.filter((call) => call.method === "sendMessage");
  assert.equal(sendCalls.length >= 3, true);
  assert.equal(
    sendCalls.every((call) => Boolean((call.args[1] as Record<string, unknown>)["m.relates_to"])),
    true,
  );
});

test("MatrixAdapter send keeps reply relation on all chunks when replyToMode is batched", async () => {
  const { runtime, calls } = createRuntimeMock();
  const adapter = new MatrixAdapter(
    createConfig({ replyToMode: "batched", textChunkLimit: 5 }),
    new Set(["@u1:example.org"]),
    runtime as never,
  );

  await adapter.send("!room:test", { text: "hello world again", replyToId: "$reply" });

  const sendCalls = calls.filter((call) => call.method === "sendMessage");
  assert.equal(sendCalls.length >= 3, true);
  assert.equal(
    sendCalls.every((call) => Boolean((call.args[1] as Record<string, unknown>)["m.relates_to"])),
    true,
  );
});

test("MatrixAdapter records poll starts in pending room history", async () => {
  const { runtime } = createRuntimeMock();
  const adapter = new MatrixAdapter(
    createConfig({ historyLimit: 2, groups: { "!room:test": { requireMention: true } } }),
    new Set<string>(),
    runtime as never,
  );
  const received: Array<{ roomContext?: string }> = [];

  adapter.onMessage(async (message) => {
    received.push({ roomContext: message.roomContext });
  });

  await adapter.start();
  await runtime.emitTimeline({
    room: createRoom({ joinedMembers: ["@bot:example.org", "@u1:example.org", "@u2:example.org"] }),
    event: createEvent({
      id: "$poll-root",
      type: "m.poll.start",
      content: {
        "m.poll.start": {
          question: { "m.text": "Lunch?" },
          kind: "m.poll.disclosed",
          max_selections: 1,
          answers: [
            { id: "a1", "m.text": "Pizza" },
            { id: "a2", "m.text": "Salad" },
          ],
        },
      },
    }),
  });
  await runtime.emitTimeline({
    room: createRoom({ joinedMembers: ["@bot:example.org", "@u1:example.org", "@u2:example.org"] }),
    event: createEvent({
      id: "$trigger-poll",
      content: {
        msgtype: "m.text",
        body: "@bot hello",
        "m.mentions": { user_ids: ["@bot:example.org"] },
      },
    }),
  });

  assert.match(received[0]?.roomContext ?? "", /\[Poll\]/);
  assert.match(received[0]?.roomContext ?? "", /Lunch\?/);
  assert.match(received[0]?.roomContext ?? "", /1\. Pizza/);
});

test("MatrixAdapter normalizes poll responses into text", async () => {
  const { runtime } = createRuntimeMock();
  runtime.sdk.fetchRoomEvent = async (_roomId: string, eventId: string) => {
    if (eventId === "$poll-root") {
      return {
        event_id: "$poll-root",
        sender: "@alice:example.org",
        type: "m.poll.start",
        content: {
          "m.poll.start": {
            question: { "m.text": "Lunch?" },
            kind: "m.poll.disclosed",
            max_selections: 1,
            answers: [
              { id: "a1", "m.text": "Pizza" },
              { id: "a2", "m.text": "Salad" },
            ],
          },
        },
      };
    }
    return {
      sender: "@alice:example.org",
      content: { msgtype: "m.text", body: "fallback" },
    };
  };
  runtime.sdk.fetchRelations = async () => ({
    chunk: [
      {
        event_id: "$poll-response",
        sender: "@u1:example.org",
        type: "m.poll.response",
        origin_server_ts: 1,
        content: {
          "m.poll.response": { answers: ["a1"] },
          "m.relates_to": { rel_type: "m.reference", event_id: "$poll-root" },
        },
      },
    ],
  });

  const adapter = new TestMatrixAdapter(
    createConfig({ groups: { "!room:test": { requireMention: false } } }),
    new Set<string>(),
    runtime as never,
  );
  const received: string[] = [];

  adapter.onMessage(async (message) => {
    received.push(message.text);
  });

  await adapter.start();
  await runtime.emitTimeline({
    room: createRoom({ joinedMembers: ["@bot:example.org", "@u1:example.org", "@u2:example.org"] }),
    event: createEvent({
      id: "$poll-response",
      type: "m.poll.response",
      content: {
        "m.poll.response": { answers: ["a1"] },
        "m.relates_to": { rel_type: "m.reference", event_id: "$poll-root" },
      },
    }),
  });
  await waitFor(() => received.length >= 1);

  assert.match(received[0] ?? "", /Lunch\?/);
  assert.match(received[0] ?? "", /Pizza \(1 vote\)/);
});

test("MatrixAdapter keeps explicit poll mention metadata for poll starts", async () => {
  const { runtime } = createRuntimeMock();
  const adapter = new MatrixAdapter(
    createConfig({ groups: { "!room:test": { requireMention: true } } }),
    new Set<string>(),
    runtime as never,
  );
  const received: string[] = [];

  adapter.onMessage(async (message) => {
    received.push(message.text);
  });

  await adapter.start();
  await runtime.emitTimeline({
    room: createRoom({ joinedMembers: ["@bot:example.org", "@u1:example.org", "@u2:example.org"] }),
    event: createEvent({
      id: "$poll-root-mention",
      type: "m.poll.start",
      content: {
        "m.poll.start": {
          question: { "m.text": "Question" },
          kind: "m.poll.disclosed",
          max_selections: 1,
          answers: [{ id: "a1", "m.text": "Yes" }],
        },
        formatted_body:
          '<a href="https://matrix.to/#/%40bot%3Aexample.org">Bot User</a> Question',
        "m.mentions": { user_ids: ["@bot:example.org"] },
      },
    }),
  });

  assert.match(received[0] ?? "", /Question/);
});
