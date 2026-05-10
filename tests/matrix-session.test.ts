import { test } from "bun:test";
import assert from "node:assert/strict";
import { SessionManager } from "../src/sessions/manager.ts";

test("resolveSessionId: 2-member room is treated as group (room-scoped session)", () => {
  const roomA = SessionManager.resolveSessionId(
    "matrix",
    "group",
    "!roomA:example.org",
    "@alice:example.org",
    { roomId: "!roomA:example.org" },
  );

  const roomB = SessionManager.resolveSessionId(
    "matrix",
    "group",
    "!roomB:example.org",
    "@alice:example.org",
    { roomId: "!roomB:example.org" },
  );

  assert.equal(roomA, "matrix/room/!roomA:example.org");
  assert.equal(roomB, "matrix/room/!roomB:example.org");
  assert.notEqual(roomA, roomB, "different rooms must have different session IDs");
});

test("resolveSessionId: DM uses user-scoped session", () => {
  const dm = SessionManager.resolveSessionId(
    "matrix",
    "dm",
    "!dm1:example.org",
    "@alice:example.org",
    { roomId: "!dm1:example.org" },
  );

  assert.equal(dm, "matrix/dm/@alice:example.org");
});

test("resolveSessionId: DM with per-room scope uses room-scoped session", () => {
  const dm = SessionManager.resolveSessionId(
    "matrix",
    "dm",
    "!dm1:example.org",
    "@alice:example.org",
    { roomId: "!dm1:example.org", sessionScope: "per-room" },
  );

  assert.equal(dm, "matrix/dm-room/!dm1:example.org");
});

test("resolveSessionId: thread uses thread-scoped session", () => {
  const thread = SessionManager.resolveSessionId(
    "matrix",
    "group",
    "!roomA:example.org",
    "@alice:example.org",
    { roomId: "!roomA:example.org", threadId: "$thread1" },
  );

  assert.equal(thread, "matrix/thread/!roomA:example.org/$thread1");
});

test("resolveSessionId: Telegram DM uses user-scoped session", () => {
  const dm = SessionManager.resolveSessionId(
    "telegram",
    "dm",
    "12345",
    "67890",
  );

  assert.equal(dm, "telegram/dm/67890");
});

test("resolveSessionId: Telegram group uses chat-scoped session", () => {
  const group = SessionManager.resolveSessionId(
    "telegram",
    "group",
    "-10012345",
    "67890",
  );

  assert.equal(group, "telegram/group/-10012345");
});

test("resolveSessionId: Telegram per-chat DM uses chat-scoped session", () => {
  const dm = SessionManager.resolveSessionId(
    "telegram",
    "dm",
    "12345",
    "67890",
    { sessionScope: "per-chat" },
  );

  assert.equal(dm, "telegram/dm-chat/12345");
});

test("resolveSessionId: Telegram thread uses thread-scoped session", () => {
  const thread = SessionManager.resolveSessionId(
    "telegram",
    "group",
    "-10012345",
    "67890",
    { threadId: "456" },
  );

  assert.equal(thread, "telegram/thread/-10012345/456");
});
