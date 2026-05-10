import { test } from "bun:test";
import assert from "node:assert/strict";
import { prefixEditedMatrixFormattedBody } from "../src/channels/matrix/format.ts";
import { MatrixMessageStreamer } from "../src/channels/matrix/stream.ts";

function createClientMock() {
  let nextId = 1;
  const calls: Array<{ method: string; args: unknown[] }> = [];
  return {
    calls,
    client: {
      async sendMessage(...args: unknown[]) {
        calls.push({ method: "sendMessage", args });
        return { event_id: `$evt${nextId++}` };
      },
      async redactEvent(...args: unknown[]) {
        calls.push({ method: "redactEvent", args });
        return { event_id: `$redact${nextId++}` };
      },
    },
  };
}

function createFailingClientMock(params: { failSendAt?: number; failEditAt?: number }) {
  let sendCount = 0;
  let redactCount = 0;
  const calls: Array<{ method: string; args: unknown[] }> = [];
  return {
    calls,
    client: {
      async sendMessage(...args: unknown[]) {
        sendCount += 1;
        calls.push({ method: "sendMessage", args });
        const content = args[1] as Record<string, unknown>;
        const isEdit = Boolean(content["m.new_content"]);
        if (!isEdit && params.failSendAt === sendCount) {
          throw new Error("preview send failed");
        }
        if (isEdit && params.failEditAt === sendCount) {
          throw new Error("preview edit failed");
        }
        return { event_id: `$evt${sendCount}` };
      },
      async redactEvent(...args: unknown[]) {
        redactCount += 1;
        calls.push({ method: "redactEvent", args });
        return { event_id: `$redact${redactCount}` };
      },
    },
  };
}

function createRetryingClientMock(params: {
  failCreateAttempts?: number;
  failEditAttempts?: number;
  failFinalEditAttempts?: number;
  failRedactAttempts?: number;
}) {
  let nextId = 1;
  let createFailures = 0;
  let editFailures = 0;
  let finalEditFailures = 0;
  let redactFailures = 0;
  const calls: Array<{ method: string; args: unknown[] }> = [];
  return {
    calls,
    client: {
      async sendMessage(...args: unknown[]) {
        calls.push({ method: "sendMessage", args });
        const content = args[1] as Record<string, unknown>;
        const isEdit = Boolean(content["m.new_content"]);
        const isFinalEdit = isEdit && content["org.matrix.msc4357.live"] === undefined;
        if (!isEdit && createFailures < (params.failCreateAttempts ?? 0)) {
          createFailures += 1;
          throw new Error("network timeout");
        }
        if (isFinalEdit && finalEditFailures < (params.failFinalEditAttempts ?? 0)) {
          finalEditFailures += 1;
          throw new Error("network timeout");
        }
        if (isEdit && !isFinalEdit && editFailures < (params.failEditAttempts ?? 0)) {
          editFailures += 1;
          throw new Error("network timeout");
        }
        return { event_id: `$evt${nextId++}` };
      },
      async redactEvent(...args: unknown[]) {
        calls.push({ method: "redactEvent", args });
        if (redactFailures < (params.failRedactAttempts ?? 0)) {
          redactFailures += 1;
          throw new Error("network timeout");
        }
        return { event_id: `$redact${nextId++}` };
      },
    },
  };
}

test("MatrixMessageStreamer waits for threshold before preview send", async () => {
  const { client, calls } = createClientMock();
  const streamer = new MatrixMessageStreamer(client as never, {
    roomId: "!room:test",
    minCharsBeforeSend: 5,
    editThrottleMs: 0,
  });

  await streamer.push("hey");
  assert.equal(calls.length, 0);

  await streamer.push("!!");
  assert.equal(calls[0]?.method, "sendMessage");
});

test("MatrixMessageStreamer finalizes with formatted matrix edit", async () => {
  const { client, calls } = createClientMock();
  const streamer = new MatrixMessageStreamer(client as never, {
    roomId: "!room:test",
    minCharsBeforeSend: 1,
    editThrottleMs: 0,
  });

  await streamer.push("hello **world**");
  await streamer.finish();

  assert.equal(calls[0]?.method, "sendMessage");
  assert.equal(calls.at(-1)?.method, "sendMessage");
  const previewContent = calls[0]?.args[1] as Record<string, unknown>;
  const finalContent = calls.at(-1)?.args[1] as Record<string, unknown>;
  assert.match(String(previewContent["formatted_body"] ?? ""), /<strong>world<\/strong>/);
  assert.equal(finalContent["msgtype"], "m.text");
  assert.equal(
    finalContent["formatted_body"],
    prefixEditedMatrixFormattedBody("<p>hello <strong>world</strong></p>"),
  );
});

test("MatrixMessageStreamer preview sends mention metadata in partial mode", async () => {
  const { client, calls } = createClientMock();
  const streamer = new MatrixMessageStreamer(client as never, {
    roomId: "!room:test",
    minCharsBeforeSend: 1,
    editThrottleMs: 0,
  });

  await streamer.push("hello @alice:example.org");

  const previewContent = calls[0]?.args[1] as Record<string, unknown>;
  assert.deepEqual(
    (previewContent["m.mentions"] as { user_ids?: string[] } | undefined)?.user_ids,
    ["@alice:example.org"],
  );
});

test("MatrixMessageStreamer quiet previews omit mention metadata but keep formatting", async () => {
  const { client, calls } = createClientMock();
  const streamer = new MatrixMessageStreamer(client as never, {
    roomId: "!room:test",
    mode: "quiet",
    minCharsBeforeSend: 1,
    editThrottleMs: 0,
  });

  await streamer.push("**hello** @alice:example.org");
  await streamer.finish("**hello** @alice:example.org");

  const previewContent = calls[0]?.args[1] as Record<string, unknown>;
  const finalContent = calls.at(-1)?.args[1] as Record<string, unknown>;
  assert.equal(previewContent["m.mentions"], undefined);
  assert.match(String(previewContent["formatted_body"] ?? ""), /<strong>hello<\/strong>/);
  const finalNewContent = finalContent["m.new_content"] as Record<string, unknown>;
  assert.deepEqual(
    (finalNewContent["m.mentions"] as { user_ids?: string[] } | undefined)?.user_ids,
    ["@alice:example.org"],
  );
  assert.deepEqual(
    (finalContent["m.mentions"] as { user_ids?: string[] } | undefined)?.user_ids,
    ["@alice:example.org"],
  );
});

test("MatrixMessageStreamer edit fallback prefixes outer formatted body", async () => {
  const { client, calls } = createClientMock();
  const streamer = new MatrixMessageStreamer(client as never, {
    roomId: "!room:test",
    minCharsBeforeSend: 1,
    editThrottleMs: 0,
  });

  await streamer.push("hello **world**");
  await streamer.finish();

  const finalContent = calls.at(-1)?.args[1] as Record<string, unknown>;
  assert.equal(
    finalContent["formatted_body"],
    prefixEditedMatrixFormattedBody("<p>hello <strong>world</strong></p>"),
  );
  const newContent = finalContent["m.new_content"] as Record<string, unknown>;
  assert.match(String(newContent["formatted_body"] ?? ""), /<strong>world<\/strong>/);
});

test("MatrixMessageStreamer keeps thread context on edits", async () => {
  const { client, calls } = createClientMock();
  const streamer = new MatrixMessageStreamer(client as never, {
    roomId: "!room:test",
    threadId: "$thread-root",
    minCharsBeforeSend: 1,
    editThrottleMs: 0,
  });

  await streamer.push("hello");
  await streamer.finish();

  const finalContent = calls.at(-1)?.args[1] as Record<string, unknown>;
  const relates = finalContent["m.relates_to"] as Record<string, unknown>;
  const reply = relates["m.in_reply_to"] as Record<string, unknown>;
  assert.equal(relates["rel_type"], "m.replace");
  assert.equal(reply["event_id"], "$thread-root");
});

test("MatrixMessageStreamer overflows to final-only fallback", async () => {
  const { client, calls } = createClientMock();
  let deliveredFinal: string | undefined;
  const streamer = new MatrixMessageStreamer(client as never, {
    roomId: "!room:test",
    minCharsBeforeSend: 1,
    editThrottleMs: 0,
    chunkLimit: 5,
    sendFinal: async (text) => {
      deliveredFinal = text;
    },
  });

  await streamer.push("abcdef");
  await streamer.finish();

  assert.equal(calls.length, 0);
  assert.equal(deliveredFinal, "abcdef");
});

test("MatrixMessageStreamer redacts preview before final fallback when draft already exists", async () => {
  const { client, calls } = createClientMock();
  let deliveredFinal: string | undefined;
  const streamer = new MatrixMessageStreamer(client as never, {
    roomId: "!room:test",
    minCharsBeforeSend: 1,
    editThrottleMs: 0,
    chunkLimit: 5,
    sendFinal: async (text) => {
      deliveredFinal = text;
    },
  });

  await streamer.push("hello");
  await streamer.push(" world");
  await streamer.finish();

  assert.equal(calls.some((call) => call.method === "redactEvent"), true);
  assert.equal(deliveredFinal, "hello world");
});

test("MatrixMessageStreamer splitForToolUse starts new preview lane", async () => {
  const { client, calls } = createClientMock();
  const streamer = new MatrixMessageStreamer(client as never, {
    roomId: "!room:test",
    minCharsBeforeSend: 1,
    editThrottleMs: 0,
  });

  await streamer.push("hello");
  await streamer.splitForToolUse();
  await streamer.push("after tool");
  await streamer.finish();

  const sends = calls.filter((call) => call.method === "sendMessage");
  assert.ok(sends.length >= 3);
});

test("MatrixMessageStreamer preserves reply target across tool boundaries when configured", async () => {
  const { client, calls } = createClientMock();
  const streamer = new MatrixMessageStreamer(client as never, {
    roomId: "!room:test",
    replyToId: "$reply",
    preserveReplyId: true,
    minCharsBeforeSend: 1,
    editThrottleMs: 0,
  });

  await streamer.push("hello");
  await streamer.splitForToolUse();
  await streamer.push("after tool");
  await streamer.finish();

  const previewCreates = calls.filter(
    (call) => call.method === "sendMessage" && !String((call.args[1] as Record<string, unknown>)["body"] ?? "").startsWith("* "),
  );
  const lastPreview = previewCreates.at(-1)?.args[1] as Record<string, unknown>;
  assert.equal(Boolean(lastPreview["m.relates_to"]), true);
});

test("MatrixMessageStreamer finalizes the current block before a tool boundary", async () => {
  const { client, calls } = createClientMock();
  const streamer = new MatrixMessageStreamer(client as never, {
    roomId: "!room:test",
    minCharsBeforeSend: 1,
    editThrottleMs: 0,
  });

  await streamer.push("hello world");
  await streamer.splitForToolUse();
  await streamer.push("done");
  await streamer.finish("done");

  const sendCalls = calls.filter((call) => call.method === "sendMessage");
  assert.ok(sendCalls.length >= 4);

  const finalizedFirstBlock = sendCalls[1]?.args[1] as Record<string, unknown>;
  const finalizedNewContent = finalizedFirstBlock["m.new_content"] as Record<string, unknown>;
  assert.equal(finalizedNewContent["body"], "hello world");
  assert.equal(finalizedFirstBlock["org.matrix.msc4357.live"], undefined);

  const postToolPreview = sendCalls[2]?.args[1] as Record<string, unknown>;
  assert.equal(String(postToolPreview["body"] ?? ""), "done");
  assert.equal(postToolPreview["m.relates_to"], undefined);
});

test("MatrixMessageStreamer falls back to normal delivery when final edit fails", async () => {
  const { client, calls } = createFailingClientMock({ failEditAt: 2 });
  let deliveredFinal: string | undefined;
  const streamer = new MatrixMessageStreamer(client as never, {
    roomId: "!room:test",
    minCharsBeforeSend: 1,
    editThrottleMs: 0,
    sendFinal: async (text) => {
      deliveredFinal = text;
    },
  });

  await streamer.push("hello");
  await streamer.finish("hello");

  assert.equal(deliveredFinal, "hello");
  assert.equal(calls.some((call) => call.method === "redactEvent"), true);
});

test("MatrixMessageStreamer falls back to final send when preview create fails", async () => {
  const { client, calls } = createFailingClientMock({ failSendAt: 1 });
  let deliveredFinal: string | undefined;
  const streamer = new MatrixMessageStreamer(client as never, {
    roomId: "!room:test",
    minCharsBeforeSend: 1,
    editThrottleMs: 0,
    sendFinal: async (text) => {
      deliveredFinal = text;
    },
  });

  await streamer.push("hello");
  await streamer.finish("hello final");

  assert.equal(deliveredFinal, "hello final");
  assert.equal(calls.some((call) => call.method === "redactEvent"), false);
});

test("MatrixMessageStreamer falls back to final send when preview edit fails", async () => {
  const { client, calls } = createFailingClientMock({ failEditAt: 2 });
  let deliveredFinal: string | undefined;
  const streamer = new MatrixMessageStreamer(client as never, {
    roomId: "!room:test",
    minCharsBeforeSend: 1,
    editThrottleMs: 0,
    sendFinal: async (text) => {
      deliveredFinal = text;
    },
  });

  await streamer.push("hello");
  await streamer.push(" world");
  await streamer.finish("hello world final");

  assert.equal(deliveredFinal, "hello world final");
  assert.equal(calls.some((call) => call.method === "redactEvent"), true);
});

test("MatrixMessageStreamer retries preview create edit final edit and redact paths", async () => {
  const { client, calls } = createRetryingClientMock({
    failCreateAttempts: 1,
    failEditAttempts: 1,
    failFinalEditAttempts: 1,
    failRedactAttempts: 1,
  });
  const streamer = new MatrixMessageStreamer(client as never, {
    roomId: "!room:test",
    minCharsBeforeSend: 1,
    editThrottleMs: 0,
  });

  await streamer.push("hello");
  await streamer.push(" world");
  await streamer.finish("hello world");
  await streamer.abort();

  assert.equal(calls.filter((call) => call.method === "sendMessage").length, 6);
  assert.equal(calls.filter((call) => call.method === "redactEvent").length, 2);

  const createCalls = calls.filter(
    (call) => call.method === "sendMessage" && typeof call.args[2] === "string" && String(call.args[2]).startsWith("stream-preview-create-"),
  );
  const editCalls = calls.filter(
    (call) => call.method === "sendMessage" && typeof call.args[2] === "string" && String(call.args[2]).startsWith("stream-preview-edit-"),
  );
  const finalEditCalls = calls.filter(
    (call) => call.method === "sendMessage" && typeof call.args[2] === "string" && String(call.args[2]).startsWith("stream-final-edit-"),
  );

  assert.equal(createCalls.length, 2);
  assert.equal(editCalls.length, 2);
  assert.equal(finalEditCalls.length, 2);
});

test("MatrixMessageStreamer quiet mode omits live marker", async () => {
  const { client, calls } = createClientMock();
  const streamer = new MatrixMessageStreamer(client as never, {
    roomId: "!room:test",
    mode: "quiet",
    minCharsBeforeSend: 1,
    editThrottleMs: 0,
  });

  await streamer.push("hello");
  await streamer.finish("hello");

  const first = calls[0]?.args[1] as Record<string, unknown>;
  const last = calls.at(-1)?.args[1] as Record<string, unknown>;
  assert.equal(first["org.matrix.msc4357.live"], undefined);
  assert.equal(last["org.matrix.msc4357.live"], undefined);
});
