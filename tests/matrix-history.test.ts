import test from "node:test";
import assert from "node:assert/strict";
import { createMatrixRoomHistoryTracker } from "../src/channels/matrix/history.ts";

test("Matrix room history snapshots keep unconsumed trigger entries across overlaps", () => {
  const tracker = createMatrixRoomHistoryTracker();

  tracker.recordPending("!room:test", {
    messageId: "$p1",
    senderId: "@alice:example.org",
    text: "pending one",
  });

  const first = tracker.prepareTrigger("!room:test", 5, {
    messageId: "$t1",
    senderId: "@alice:example.org",
    text: "@bot first",
  });
  const second = tracker.prepareTrigger("!room:test", 5, {
    messageId: "$t2",
    senderId: "@alice:example.org",
    text: "@bot second",
  });

  assert.deepEqual(first.history.map((entry) => entry.text), ["pending one"]);
  assert.deepEqual(second.history.map((entry) => entry.text), ["pending one", "@bot first"]);

  tracker.consumeHistory("!room:test", first);
  tracker.recordPending("!room:test", {
    messageId: "$p2",
    senderId: "@alice:example.org",
    text: "pending two",
  });

  const third = tracker.prepareTrigger("!room:test", 5, {
    messageId: "$t3",
    senderId: "@alice:example.org",
    text: "@bot third",
  });

  assert.deepEqual(third.history.map((entry) => entry.text), ["@bot second", "pending two"]);
});
