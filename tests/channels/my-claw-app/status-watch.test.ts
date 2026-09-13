import { test, expect } from "bun:test";
import type { ServerWebSocket } from "bun";
import { StatusWatch } from "../../../src/channels/my-claw-app/status-watch.ts";
import type { MyClawAppSessionData } from "../../../src/channels/my-claw-app/controllers.ts";
import type { MyClawAppStatusPayload, MyClawAppStatusResult } from "../../../src/channels/my-claw-app/types.ts";

type Ws = ServerWebSocket<MyClawAppSessionData>;

function socket(name: string): Ws {
  return { name } as unknown as Ws;
}

const PAYLOAD = { session: null } as unknown as MyClawAppStatusPayload;

function world(opts: { payers?: Record<string, string>; fail?: boolean } = {}) {
  const sent: Array<{ ws: string; frame: MyClawAppStatusResult }> = [];
  const reports: string[] = [];
  const watch = new StatusWatch({
    report: async (owner, threadId) => {
      reports.push(`${owner}/${threadId}`);
      return opts.fail ? undefined : { ...PAYLOAD, session: { id: `${owner}/${threadId}`, createdAt: "", lastActiveAt: "", turns: reports.length } };
    },
    send: (ws, frame) => sent.push({ ws: (ws as unknown as { name: string }).name, frame }),
    sessionOf: (owner, threadId) => (threadId.startsWith("subagent/") ? threadId : `my-claw-app/thread/${owner}/${threadId}`),
    parentOf: async (sessionId) => opts.payers?.[sessionId],
    settleMs: 20,
  });
  return { watch, sent, reports };
}

const settle = () => new Promise((r) => setTimeout(r, 60));

test("a watch is the first fetch: the page gets its report at once", async () => {
  const { watch, sent, reports } = world();
  await watch.watch(socket("a"), "o", "t1");
  expect(reports).toEqual(["o/t1"]);
  expect(sent.map((s) => s.frame.threadId)).toEqual(["t1"]);
});

test("a burst of changes on one conversation is one report, sent to every page open on it", async () => {
  const { watch, sent, reports } = world();
  await watch.watch(socket("a"), "o", "t1");
  await watch.watch(socket("b"), "o", "t1");
  reports.length = 0;
  sent.length = 0;
  // A call recorded, its run finishing and the compaction it triggered land within milliseconds.
  await watch.changed("my-claw-app/thread/o/t1");
  await watch.changed("my-claw-app/thread/o/t1");
  await watch.changed("my-claw-app/thread/o/t1");
  expect(sent).toEqual([]);
  await settle();
  expect(reports).toEqual(["o/t1"]);
  expect(sent.map((s) => s.ws).sort()).toEqual(["a", "b"]);
});

test("a change in a sub-agent reaches the page of the conversation it bills to, two levels up", async () => {
  const parent = "my-claw-app/thread/o/t1";
  const { watch, sent } = world({ payers: { "subagent/coder": "subagent/research", "subagent/research": parent } });
  await watch.watch(socket("a"), "o", "t1");
  await watch.watch(socket("sub"), "o", "subagent/research");
  sent.length = 0;
  await watch.changed("subagent/coder");
  await settle();
  // The grandchild's own page is not open; its parent's and the conversation's are.
  expect(sent.map((s) => `${s.ws}:${s.frame.threadId}`).sort()).toEqual(["a:t1", "sub:subagent/research"]);
});

test("the payer the event names is followed even when the session cannot be read", async () => {
  // A killed one-shot has no session left to read a parent from: the recorded row still says who paid.
  const { watch, sent } = world();
  await watch.watch(socket("a"), "o", "t1");
  sent.length = 0;
  await watch.changed("subagent/run-gone", "my-claw-app/thread/o/t1");
  await settle();
  expect(sent.map((s) => s.frame.threadId)).toEqual(["t1"]);
});

test("a change elsewhere, an unwatched page, a page moved to another thread: nothing is sent", async () => {
  const { watch, sent } = world();
  const a = socket("a");
  await watch.watch(a, "o", "t1");
  sent.length = 0;
  await watch.changed("my-claw-app/thread/o/t2");
  await settle();
  expect(sent).toEqual([]);

  // The same socket opens another conversation's page: the first is no longer watched.
  await watch.watch(a, "o", "t3");
  sent.length = 0;
  await watch.changed("my-claw-app/thread/o/t1");
  await settle();
  expect(sent).toEqual([]);
  expect(watch.size()).toBe(1);

  watch.unwatch(a);
  await watch.changed("my-claw-app/thread/o/t3");
  await settle();
  expect(sent).toEqual([]);
  expect(watch.size()).toBe(0);
});

test("a report that cannot be built sends nothing, and a page closed meanwhile gets nothing late", async () => {
  const failing = world({ fail: true });
  await failing.watch.watch(socket("a"), "o", "t1");
  expect(failing.sent).toEqual([]);

  const { watch, sent } = world();
  const a = socket("a");
  await watch.watch(a, "o", "t1");
  sent.length = 0;
  await watch.changed("my-claw-app/thread/o/t1");
  watch.unwatch(a);
  await settle();
  expect(sent).toEqual([]);
});

/**
 * A provider's ledger is the one figure on a report that belongs to no conversation, so the push
 * it triggers is aimed at every page rather than at a session chain.
 */
test("a ledger reading refreshes every page open, whatever conversation each is on", async () => {
  const { watch, sent, reports } = world();
  await watch.watch(socket("a"), "o", "t1");
  await watch.watch(socket("b"), "o", "t2");
  reports.length = 0;
  sent.length = 0;

  watch.refreshed();
  expect(sent).toEqual([]);
  await settle();
  expect(reports.sort()).toEqual(["o/t1", "o/t2"]);
  expect(sent.map((s) => `${s.ws}:${s.frame.threadId}`).sort()).toEqual(["a:t1", "b:t2"]);
});

test("two readings in one burst are still one report per page, and none at all with no page open", async () => {
  const { watch, sent, reports } = world();
  // Nothing is watching: the event costs a walk over an empty map and builds no report.
  watch.refreshed();
  await settle();
  expect(reports).toEqual([]);

  await watch.watch(socket("a"), "o", "t1");
  reports.length = 0;
  sent.length = 0;
  watch.refreshed();
  watch.refreshed();
  await settle();
  expect(reports).toEqual(["o/t1"]);
  expect(sent).toHaveLength(1);
});
