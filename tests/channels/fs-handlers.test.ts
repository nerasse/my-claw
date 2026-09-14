import { test, expect, afterEach } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ServerWebSocket } from "bun";
import {
  handleFsList,
  handleFsRead,
  handleFsRemove,
  handleFsSessionRoot,
  handleFsUnwatch,
  handleFsWatch,
  handleFsWrite,
  type MyClawAppFsDeps,
} from "../../src/channels/my-claw-app/fs-handlers.ts";
import { FsWatchRegistry, readFileWindow } from "../../src/channels/my-claw-app/fs-ops.ts";
import { MY_CLAW_DIR } from "../../src/core/config.ts";
import type { MyClawAppSessionData } from "../../src/channels/my-claw-app/controllers.ts";
import type {
  MyClawAppError,
  MyClawAppFsChanged,
  MyClawAppFsListResult,
  MyClawAppFsReadResult,
  MyClawAppFsWatchResult,
  MyClawAppFsWriteResult,
  MyClawAppServerFrame,
} from "../../src/channels/my-claw-app/types.ts";

/**
 * The files page's frame handlers -- docs/files-page.md. Every test runs against the deps object
 * the adapter would build, with a socket stand-in: what is asserted is what crosses the wire.
 */

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "fs-handlers-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

type Ws = ServerWebSocket<MyClawAppSessionData>;

function harness(over: Partial<MyClawAppFsDeps> = {}) {
  const frames: MyClawAppServerFrame[] = [];
  const ws = { data: { deviceId: "dev", owner: "neras", lastSeen: 0 }, send: () => {} } as unknown as Ws;
  const deps: MyClawAppFsDeps = {
    sendFrame: (_ws, frame) => frames.push(frame),
    // Mirrors the adapter's refusalFrame: the error's message is the conflict-free reason.
    refuse: async (_ws, scope, message, data = {}) => {
      frames.push({ type: "error", scope, message, ...(typeof data.error === "string" ? { detail: data.error } : {}) });
    },
    watches: new FsWatchRegistry(30),
    ...over,
  };
  return { frames, ws, deps };
}

const guardsFor = (root: string) => ({
  home: join(root, "home"),
  myClawDir: join(root, "data"),
  defaultWorkspace: join(root, "workspace"),
  cwd: join(root, "proj"),
});

test("a listing answers with the normalised path, its parent and the readdir order", async () => {
  const dir = temp();
  writeFileSync(join(dir, "a.txt"), "a");
  writeFileSync(join(dir, "b.txt"), "b");
  const { frames, ws, deps } = harness();

  await handleFsList(deps, ws, { type: "fs.list", path: join(dir, "sub", "..") });
  const frame = frames[0] as MyClawAppFsListResult;
  expect(frame.type).toBe("fs.list.result");
  expect(frame.path).toBe(dir);
  expect(frame.parent).toBe(dirname(dir));
  expect(frame.truncated).toBe(false);
  expect(frame.entries.map((entry) => entry.name).sort()).toEqual(["a.txt", "b.txt"]);
});

test("a listing that cannot be read says so in its own frame, never a crash", async () => {
  const dir = temp();
  const { frames, ws, deps } = harness();
  await handleFsList(deps, ws, { type: "fs.list", path: join(dir, "missing") });
  const frame = frames[0] as MyClawAppFsListResult;
  expect(frame.type).toBe("fs.list.result");
  expect(frame.entries).toEqual([]);
  expect(typeof frame.error).toBe("string");
});

test("a read of binary answers with the reason and no text key at all", async () => {
  const path = join(temp(), "blob.bin");
  writeFileSync(path, Buffer.from([0x00, 0x01, 0x02, 0x03]));
  const { frames, ws, deps } = harness();

  await handleFsRead(deps, ws, { type: "fs.read", path });
  const frame = frames[0] as MyClawAppFsReadResult;
  expect(frame.binary).toEqual({ reason: "nul" });
  expect("text" in frame).toBe(false);
  expect(frame.etag).toBeString();
});

test("a stale write is answered with the conflict and writes nothing", async () => {
  const path = join(temp(), "conflict.txt");
  writeFileSync(path, "original\n");
  const read = await readFileWindow(path);
  appendFileSync(path, "changed\n");
  const { frames, ws, deps } = harness();

  await handleFsWrite(deps, ws, { type: "fs.write", path, text: "mine\n", etag: read.etag });
  const frame = frames[0] as MyClawAppFsWriteResult;
  expect(frame.conflict).toBeDefined();
  expect(readFileSync(path, "utf8")).toBe("original\nchanged\n");
});

test("a write is logged with path and size, and the text never reaches a log line", async () => {
  const path = join(temp(), "logged.txt");
  writeFileSync(path, "one\n");
  const read = await readFileWindow(path);
  const { ws, deps } = harness();

  await handleFsWrite(deps, ws, { type: "fs.write", path, text: "SECRET-MARKER-3827\n", etag: read.etag });
  expect(readFileSync(path, "utf8")).toBe("SECRET-MARKER-3827\n");

  const logFile = join(MY_CLAW_DIR, "logs", `my-claw-app-${new Date().toISOString().slice(0, 10)}.log`);
  const logText = readFileSync(logFile, "utf8");
  expect(logText).toContain(path);
  expect(logText).toContain("fs.write");
  expect(logText).not.toContain("SECRET-MARKER-3827");
});

test("fs.remove refuses the protected roots by name and deletes nothing", async () => {
  const root = temp();
  const data = join(root, "data");
  mkdirSync(join(data, "inner"), { recursive: true });
  writeFileSync(join(data, "keep.txt"), "keep");
  const { frames, ws, deps } = harness({
    fs: { sessionRoot: async () => root, protectedRoots: () => guardsFor(root) },
  });

  await handleFsRemove(deps, ws, { type: "fs.remove", path: data, recursive: true });
  const refusal = frames[0] as MyClawAppError;
  expect(refusal.type).toBe("error");
  expect(refusal.scope).toBe("fs");
  expect(refusal.message).toContain("my-claw data directory");
  expect(existsSync(join(data, "keep.txt"))).toBe(true);

  // Outside the guards, the removal goes through.
  const loose = join(root, "loose.txt");
  writeFileSync(loose, "x");
  frames.length = 0;
  await handleFsRemove(deps, ws, { type: "fs.remove", path: loose });
  expect(frames[0]).toMatchObject({ type: "fs.remove.result", path: loose });
  expect(existsSync(loose)).toBe(false);
});

test("the watch cap is eight per connection, and a disconnect drops what it held", async () => {
  const dir = temp();
  const files = Array.from({ length: 9 }, (_, i) => join(dir, `w${i}.txt`));
  for (const file of files) writeFileSync(file, "x");
  const { frames, ws, deps } = harness();

  for (let i = 0; i < 9; i += 1) {
    frames.length = 0;
    await handleFsWatch(deps, ws, { type: "fs.watch", path: files[i]! });
    const frame = frames[0] as MyClawAppFsWatchResult;
    expect(frame.watching).toBe(i < 8);
  }
  expect(deps.watches.count(ws)).toBe(8);

  frames.length = 0;
  await handleFsUnwatch(deps, ws, { type: "fs.unwatch", path: files[0]! });
  expect(frames[0]).toMatchObject({ type: "fs.watch.result", path: files[0], watching: false });
  expect(deps.watches.count(ws)).toBe(7);

  frames.length = 0;
  await handleFsWatch(deps, ws, { type: "fs.watch", path: files[8]! });
  expect((frames[0] as MyClawAppFsWatchResult).watching).toBe(true);

  deps.watches.drop(ws);
  expect(deps.watches.count(ws)).toBe(0);
});

test("a watched file pushes fs.changed, and unwatch stops the pushes", async () => {
  const dir = temp();
  const file = join(dir, "tail.log");
  writeFileSync(file, "a\n");
  const { frames, ws, deps } = harness();
  await handleFsWatch(deps, ws, { type: "fs.watch", path: file });

  const pushed = () => frames.filter((frame): frame is MyClawAppFsChanged => frame.type === "fs.changed");
  const deadline = Date.now() + 10_000;
  while (pushed().length === 0) {
    if (Date.now() > deadline) throw new Error("timed out waiting for fs.changed");
    appendFileSync(file, "b\n");
    await Bun.sleep(80);
  }
  const frame = pushed()[0]!;
  expect(frame.path).toBe(file);
  expect(frame.kind).toBe("changed");
  expect(frame.size).toBeGreaterThan(1);

  await handleFsUnwatch(deps, ws, { type: "fs.unwatch", path: file });
  const seen = pushed().length;
  appendFileSync(file, "c\n");
  await Bun.sleep(120);
  appendFileSync(file, "d\n");
  await Bun.sleep(120);
  expect(pushed().length).toBe(seen);
});

test("session.root resolves through the provider, and a bad threadId is refused", async () => {
  const { frames, ws, deps } = harness({
    fs: {
      sessionRoot: async (owner, threadId) => `/srv/${owner}/${threadId}`,
      protectedRoots: () => guardsFor("/"),
    },
  });

  await handleFsSessionRoot(deps, ws, { type: "fs.session.root", threadId: "sub-0123456789abcdef" });
  expect(frames[0]).toMatchObject({
    type: "fs.session.root.result",
    threadId: "sub-0123456789abcdef",
    path: "/srv/neras/sub-0123456789abcdef",
  });

  frames.length = 0;
  await handleFsSessionRoot(deps, ws, { type: "fs.session.root", threadId: "bad/id" });
  expect(frames[0]).toMatchObject({ type: "error", scope: "fs" });
});

test("without an fs provider the page refuses rather than guessing a directory", async () => {
  const { frames, ws, deps } = harness();
  await handleFsSessionRoot(deps, ws, { type: "fs.session.root", threadId: "default" });
  expect(frames[0]).toMatchObject({ type: "error", scope: "fs" });
});
