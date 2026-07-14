import { test } from "bun:test";
import assert from "node:assert/strict";
import { recreateChannelAdapter, type RecreatableAdapter } from "../../src/channels/recreate.ts";

class FakeAdapter implements RecreatableAdapter {
  stopped = false;
  constructor(public readonly id: string, private readonly seq: string[], private readonly throwOnStop = false) {}
  async stop(): Promise<void> {
    this.seq.push(`stop:${this.id}`);
    this.stopped = true;
    if (this.throwOnStop) throw new Error("stop failed");
  }
}

test("stops the old adapter before building the new one (sequential)", async () => {
  const seq: string[] = [];
  const old = new FakeAdapter("old", seq);
  const adapters: RecreatableAdapter[] = [old];
  let repointed: FakeAdapter | undefined;

  const next = await recreateChannelAdapter<FakeAdapter>({
    current: old,
    adapters,
    build: async () => {
      seq.push("build");
      const a = new FakeAdapter("new", seq);
      adapters.push(a);
      return a;
    },
    repoint: (n) => { repointed = n; },
    label: "test",
  });

  assert.deepEqual(seq, ["stop:old", "build"], "stop must complete before build");
  assert.equal(old.stopped, true);
  assert.equal(next?.id, "new");
  assert.equal(repointed?.id, "new");
  // old removed, new present
  assert.deepEqual(adapters.map((a) => (a as FakeAdapter).id), ["new"]);
});

test("removes exactly the old adapter from the shared list", async () => {
  const seq: string[] = [];
  const old = new FakeAdapter("old", seq);
  const other = new FakeAdapter("other", seq);
  const adapters: RecreatableAdapter[] = [other, old];

  await recreateChannelAdapter<FakeAdapter>({
    current: old,
    adapters,
    build: async () => { const a = new FakeAdapter("new", seq); adapters.push(a); return a; },
    repoint: () => {},
  });

  assert.deepEqual(adapters.map((a) => (a as FakeAdapter).id), ["other", "new"]);
});

test("a throwing stop is isolated; the new adapter still comes up", async () => {
  const seq: string[] = [];
  const old = new FakeAdapter("old", seq, true);
  const adapters: RecreatableAdapter[] = [old];
  let repointed: FakeAdapter | undefined;

  const next = await recreateChannelAdapter<FakeAdapter>({
    current: old,
    adapters,
    build: async () => { const a = new FakeAdapter("new", seq); adapters.push(a); return a; },
    repoint: (n) => { repointed = n; },
  });

  assert.equal(next?.id, "new");
  assert.equal(repointed?.id, "new");
  assert.deepEqual(adapters.map((a) => (a as FakeAdapter).id), ["new"]);
});

test("with no current adapter, it just builds and repoints (no stop)", async () => {
  const seq: string[] = [];
  const adapters: RecreatableAdapter[] = [];
  let repointed: FakeAdapter | undefined;

  const next = await recreateChannelAdapter<FakeAdapter>({
    current: undefined,
    adapters,
    build: async () => { const a = new FakeAdapter("new", seq); adapters.push(a); return a; },
    repoint: (n) => { repointed = n; },
  });

  assert.deepEqual(seq, []);
  assert.equal(next?.id, "new");
  assert.equal(repointed?.id, "new");
});

test("repoints with undefined when the channel is now disabled", async () => {
  const seq: string[] = [];
  const old = new FakeAdapter("old", seq);
  const adapters: RecreatableAdapter[] = [old];
  let repointCalled = false;
  let repointedValue: FakeAdapter | undefined = old;

  await recreateChannelAdapter<FakeAdapter>({
    current: old,
    adapters,
    build: async () => undefined,
    repoint: (n) => { repointCalled = true; repointedValue = n; },
  });

  assert.equal(repointCalled, true);
  assert.equal(repointedValue, undefined);
  assert.deepEqual(adapters, []);
});
