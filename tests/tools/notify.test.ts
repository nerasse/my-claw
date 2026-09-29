import { test, beforeEach, afterEach } from "bun:test";
import assert from "node:assert/strict";
import { createNotifyTool, notifyTarget } from "../../src/tools/notify.ts";
import { endpointStore, resetPushState } from "../../src/notifications/push.ts";
import { withRunContext } from "../../src/utils/run-context.ts";
import { mockFetch } from "../helpers/mock-fetch.ts";

// A real subscription key pair: web-push has to encrypt against it, and a made-up key throws
// before the request is ever built (same pair as tests/notifications/push.test.ts).
const endpoint = {
  endpoint: "https://push.example/up/one",
  pubKey: "BL4V3Dus18yzlGuLrjd-st4VlRaWvdY7oCNkxgEGIUctWbZjh9zHYdqjodOFXOABzanFmGcUtn0Y131wy8hHDEk",
  auth: "alrZHgX8MDe_DISRVbWZ1A",
  updatedAt: "2026-09-17T00:00:00.000Z",
};

/**
 * One registered device, and how many times the push server was handed a notification. The body
 * is encrypted on the wire -- that is the point of the transport -- so what a test can read here
 * is the count; the payload's own fields are asserted on buildPushPayload.
 */
async function withDevice(): Promise<{ sends: () => number; restore: () => void }> {
  await resetPushState();
  await endpointStore.register("dev-1", endpoint);
  let count = 0;
  const mocked = mockFetch(async () => {
    count += 1;
    return new Response("", { status: 201 });
  });
  return { sends: () => count, restore: () => mocked.restore() };
}

beforeEach(async () => {
  await resetPushState();
});

afterEach(async () => {
  await resetPushState();
});

test("notify publishes to every registered device and says how many", async () => {
  const { sends, restore } = await withDevice();
  const tool = createNotifyTool();

  const result = await tool.execute({ body: "The build is red.", title: "CI" });

  assert.equal(result.success, true);
  assert.equal(result.output, "notified 1 device(s)");
  assert.equal(sends(), 1);
  restore();
});

test("a body is required: no body, no notification", async () => {
  const { sends, restore } = await withDevice();
  const tool = createNotifyTool();

  const result = await tool.execute({ body: "   " });

  assert.equal(result.success, false);
  assert.match(String(result.error), /body is required/);
  assert.equal(sends(), 0);
  restore();
});

test("no registered device is a failure the agent can see, not a silent no-op", async () => {
  await resetPushState();
  const tool = createNotifyTool();

  const result = await tool.execute({ body: "anyone?" });

  assert.equal(result.success, false);
  assert.match(String(result.error), /no device is registered/);
});

test("ring is honoured once, and the agent is told it was", async () => {
  const { sends, restore } = await withDevice();
  const tool = createNotifyTool();

  const plain = await tool.execute({ body: "plain" });
  const rung = await tool.execute({ body: "act now", ring: true });

  assert.equal(plain.output, "notified 1 device(s)");
  assert.match(rung.output, /and it rang/);
  assert.equal(sends(), 2);
  restore();
});

test("a second ring inside ten minutes is downgraded, and what it had to say still arrives", async () => {
  const { sends, restore } = await withDevice();
  const tool = createNotifyTool();

  const first = await tool.execute({ body: "first", ring: true });
  const second = await tool.execute({ body: "second", ring: true });

  assert.match(first.output, /and it rang/);
  assert.equal(second.success, true);
  assert.match(second.output, /rang recently so this one is ordinary/);
  assert.equal(sends(), 2);
  restore();
});

test("the tap follows the run's session: its thread, and a cron run's own thread", async () => {
  const inThread = await withRunContext({ platform: "my-claw-app", sessionId: "my-claw-app/thread/neras/t-42", threadId: "t-42" }, () =>
    Promise.resolve(notifyTarget()),
  );
  const inJob = await withRunContext({ platform: "cron", sessionId: "cron/0123456789ab/1790658020173", jobId: "0123456789ab" }, () =>
    Promise.resolve(notifyTarget()),
  );
  assert.deepEqual(inThread, { kind: "thread", threadId: "t-42" });
  // The run itself, where the agent that rang is. The job page listed the job and nothing of it.
  assert.deepEqual(inJob, { kind: "thread", threadId: "cron-0123456789ab-1790658020173" });
  assert.equal(notifyTarget(), undefined);
});
