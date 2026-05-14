import { test, expect } from "bun:test";
import { MatrixMessageStreamer, type MatrixStreamOptions } from "../../src/channels/matrix/stream.ts";

function createMockClient() {
  const sent: Array<Record<string, unknown>> = [];

  return {
    sent,
    async sendMessage(_roomId: string, content: Record<string, unknown>, _txnId?: string) {
      sent.push(content);
      return { event_id: `ev-${sent.length}` };
    },
    async redactEvent() {},
  };
}

test("Matrix appendToolUse verbose mode shows args and timing", async () => {
  const client = createMockClient();
  const streamer = new MatrixMessageStreamer(client as never, {
    roomId: "!room:server",
    minCharsBeforeSend: 1,
    editThrottleMs: 0,
    chunkLimit: 4000,
  } as MatrixStreamOptions);

  await streamer.push("Hello");
  await streamer.appendToolUse([{ name: "bash", arguments: { command: "ls" }, durationMs: 120 }], true);
  await streamer.push(" world");
  await streamer.finish();

  expect(client.sent.length).toBeGreaterThanOrEqual(1);
  const lastBody = String(client.sent[client.sent.length - 1]?.body ?? "");
  expect(lastBody).toContain("bash({\"command\":\"ls\"}) [120ms]");
  expect(lastBody).toContain("world");
});

test("Matrix appendToolUse compact mode shows names only", async () => {
  const client = createMockClient();
  const streamer = new MatrixMessageStreamer(client as never, {
    roomId: "!room:server",
    minCharsBeforeSend: 1,
    editThrottleMs: 0,
    chunkLimit: 4000,
  } as MatrixStreamOptions);

  await streamer.push("Hello");
  await streamer.appendToolUse([
    { name: "bash", arguments: { command: "ls" }, durationMs: 100 },
    { name: "read", arguments: { path: "/tmp" }, durationMs: 50 },
  ], false);
  await streamer.finish();

  const lastBody = String(client.sent[client.sent.length - 1]?.body ?? "");
  expect(lastBody).toContain("> bash, read");
  expect(lastBody).not.toContain("command");
});
