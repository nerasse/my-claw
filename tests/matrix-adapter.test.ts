import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { MatrixAdapter } from "../src/channels/matrix.ts";
import type { MatrixChannelConfig } from "../src/config.ts";

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

function createRuntimeMock() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const timelineHandlers: Array<(payload: { room: unknown; event: unknown; toStartOfTimeline: boolean; removed: boolean }) => void | Promise<void>> = [];
  let encryptedRooms = new Set<string>();
  const sdk: {
    on: () => void;
    off: () => void;
    sendMessage: (...args: unknown[]) => Promise<{ event_id: string }>;
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
      mediaCrypto: {
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
      onTimeline(handler: (payload: { room: unknown; event: unknown; toStartOfTimeline: boolean; removed: boolean }) => void | Promise<void>) {
        timelineHandlers.push(handler);
        return () => {};
      },
      async start() {},
      async stop() {},
      setEncryptedRooms(roomIds: string[]) {
        encryptedRooms = new Set(roomIds);
      },
      async emitTimeline(payload: { room: unknown; event: unknown; toStartOfTimeline?: boolean; removed?: boolean }) {
        for (const handler of timelineHandlers) {
          await handler({
            room: payload.room,
            event: payload.event,
            toStartOfTimeline: payload.toStartOfTimeline ?? false,
            removed: payload.removed ?? false,
          });
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
  };
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

test("MatrixAdapter marks DM messages with configured per-room session scope", async () => {
  const { runtime } = createRuntimeMock();
  const adapter = new MatrixAdapter(
    createConfig({ dm: { sessionScope: "per-room", allowFrom: ["@u1:example.org"] } }),
    new Set(["@u1:example.org"]),
    runtime as never,
  );
  const receivedScopes: Array<"per-user" | "per-room" | undefined> = [];

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
    text:
      data === "mdl:1"
        ? "Model changed to Alt\n\nCurrent model: Alt\nReact to this message or send `/model <number|name>`:\n1️⃣ Base\n2️⃣ Alt [selected]"
        : "Current model: Base",
    buttons: [
      { label: data === "mdl:1" ? "Base" : "Base [selected]", action: "mdl:0" },
      { label: data === "mdl:1" ? "Alt [selected]" : "Alt", action: "mdl:1" },
    ],
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
  assert.match(String(editPayload["formatted_body"] ?? ""), /^\* /);
  assert.match(String(newContent["body"] ?? ""), /Model changed to Alt/);
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
    room: createRoom(),
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

test("MatrixAdapter decrypts encrypted media attachments when crypto is available", async () => {
  const { runtime } = createRuntimeMock();
  const adapter = new MatrixAdapter(createConfig(), new Set(["@u1:example.org"]), runtime as never);
  const received: Array<{ attachments: Array<{ path?: string; summaryText?: string }> }> = [];

  adapter.onMessage(async (message) => {
    received.push({ attachments: message.attachments });
  });

  await adapter.start();
  await runtime.emitTimeline({
    room: createRoom(),
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

  const tempPath = "/tmp/opencode/matrix-encrypted-upload.txt";
  await writeFile(tempPath, "hello encrypted world");

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
      groupAllowFrom: ["@helperbot:example.org"],
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
    event: createEvent({ sender: "@helperbot:example.org" }),
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

  const adapter = new MatrixAdapter(
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
