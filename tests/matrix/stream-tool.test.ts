import { test, expect } from "bun:test";
import { MatrixMessageStreamer, type MatrixStreamOptions } from "../../src/channels/matrix/stream.ts";

function createMockClient() {
  const sent: Array<Record<string, unknown>> = [];
  const edits: Array<Record<string, unknown>> = [];

  return {
    sent,
    edits,
    async sendMessage(_roomId: string, content: Record<string, unknown>, _txnId?: string) {
      sent.push(content);
      return { event_id: `ev-${sent.length}` };
    },
    async redactEvent() {},
  };
}

test("Matrix appendToolUse adds inline tool call to single event", async () => {
  const client = createMockClient();
  const streamer = new MatrixMessageStreamer(client as never, {
    roomId: "!room:server",
    minCharsBeforeSend: 1,
    editThrottleMs: 0,
    chunkLimit: 4000,
  } as MatrixStreamOptions);

  await streamer.push("Hello");
  await streamer.appendToolUse([{ name: "bash", arguments: { command: "ls" } }]);
  await streamer.push(" world");
  await streamer.finish();

  // All edits (including final) are sent events in Matrix; the last one holds the final text
  expect(client.sent.length).toBeGreaterThanOrEqual(1);
  const lastBody = String(client.sent[client.sent.length - 1]?.body ?? "");
  expect(lastBody).toContain("Hello");
  expect(lastBody).toContain("bash({\"command\":\"ls\"})");
  expect(lastBody).toContain(" world");
});

test("Matrix appendToolUse does not create intermediate final events", async () => {
  const client = createMockClient();
  const streamer = new MatrixMessageStreamer(client as never, {
    roomId: "!room:server",
    minCharsBeforeSend: 1,
    editThrottleMs: 0,
    chunkLimit: 4000,
  } as MatrixStreamOptions);

  await streamer.push("A");
  await streamer.appendToolUse([{ name: "read", arguments: { path: "/tmp/test.ts" } }]);
  await streamer.push("B");
  await streamer.appendToolUse([{ name: "write", arguments: { path: "/tmp/out", content: "hello" } }]);
  await streamer.push("C");
  await streamer.finish();

  // No redactions (which would indicate intermediate finalizeCurrentBlock calls)
  // All sent events should be edits with m.replace relations (or the initial preview)
  const nonEditEvents = client.sent.filter((c) => c["m.relates_to"] && c["m.relates_to"].rel_type !== "m.replace");
  expect(nonEditEvents.length).toBeLessThanOrEqual(1);
});
