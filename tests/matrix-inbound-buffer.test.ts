import test from "node:test";
import assert from "node:assert/strict";
import { createMatrixInboundBuffer } from "../src/channels/matrix/inbound-buffer.ts";

test("matrix inbound buffer coalesces nearby messages from same sender", () => {
  const buffer = createMatrixInboundBuffer({ coalesceWindowMs: 1000, maxItems: 4 });
  const first = buffer.coalesce("!room:test", {
    eventId: "$a",
    senderId: "@u1:example.org",
    text: "hello",
    content: {},
    attachments: [],
    timestampMs: 1000,
  });
  const second = buffer.coalesce("!room:test", {
    eventId: "$b",
    senderId: "@u1:example.org",
    text: "world",
    content: {},
    attachments: [{ type: "file", filename: "x.txt" }],
    timestampMs: 1500,
  });

  assert.equal(first.mergedIntoEventId, undefined);
  assert.equal(second.mergedIntoEventId, "$a");
  assert.equal(second.item.eventId, "$b");
  assert.equal(second.item.text, "hello\nworld");
  assert.equal(second.item.attachments?.length, 1);
});

test("matrix inbound buffer does not coalesce distant or different-sender messages", () => {
  const buffer = createMatrixInboundBuffer({ coalesceWindowMs: 1000, maxItems: 4 });
  buffer.coalesce("!room:test", {
    eventId: "$a",
    senderId: "@u1:example.org",
    text: "hello",
    content: {},
    timestampMs: 1000,
  });
  const second = buffer.coalesce("!room:test", {
    eventId: "$b",
    senderId: "@u2:example.org",
    text: "other",
    content: {},
    timestampMs: 1200,
  });
  const third = buffer.coalesce("!room:test", {
    eventId: "$c",
    senderId: "@u2:example.org",
    text: "later",
    content: {},
    timestampMs: 3000,
  });

  assert.equal(second.mergedIntoEventId, undefined);
  assert.equal(third.mergedIntoEventId, undefined);
});

test("matrix inbound buffer clears room entries by event id", () => {
  const buffer = createMatrixInboundBuffer({ coalesceWindowMs: 1000, maxItems: 4 });
  buffer.coalesce("!room:test", {
    eventId: "$a",
    senderId: "@u1:example.org",
    text: "hello",
    content: {},
    timestampMs: 1000,
  });
  buffer.clear("!room:test", "$a");
  const next = buffer.coalesce("!room:test", {
    eventId: "$b",
    senderId: "@u1:example.org",
    text: "fresh",
    content: {},
    timestampMs: 1200,
  });

  assert.equal(next.mergedIntoEventId, undefined);
  assert.equal(next.item.text, "fresh");
});
