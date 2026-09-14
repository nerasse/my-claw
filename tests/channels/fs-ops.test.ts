import { test, expect, afterEach } from "bun:test";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FS_READ_MAX,
  FsWatchRegistry,
  fsRemoveRefusal,
  listDirectory,
  makeDirectory,
  moveEntry,
  readFileWindow,
  removeEntry,
  textHintFor,
  writeTextFile,
} from "../../src/channels/my-claw-app/fs-ops.ts";

/**
 * The files page's pure half -- docs/files-page.md. Everything here runs without a socket: the
 * listing, the read window and its encodings, the atomic write and its etag contract, the removal
 * guards, and the watchers.
 */

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "fs-ops-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function guard(): string {
  const dir = mkdtempSync(join(tmpdir(), "fs-ops-"));
  cleanups.push(() => {
    try {
      chmodSync(dir, 0o755);
    } catch {
      // already gone or never nagged
    }
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test("a listing carries kinds, sizes and the cheap extension guess, in readdir order", async () => {
  const dir = temp();
  writeFileSync(join(dir, "notes.txt"), "hello");
  mkdirSync(join(dir, "sub"));
  writeFileSync(join(dir, "pic.png"), Buffer.from([0x89, 0x50]));
  symlinkSync(join(dir, "notes.txt"), join(dir, "link.txt"));
  symlinkSync(join(dir, "gone"), join(dir, "dangling"));

  const listing = await listDirectory(dir);
  expect(listing.truncated).toBe(false);
  const byName = new Map(listing.entries.map((entry) => [entry.name, entry]));

  expect(byName.get("notes.txt")).toMatchObject({ kind: "file", size: 5, textHint: true });
  expect(byName.get("notes.txt")!.path).toBe(join(dir, "notes.txt"));
  expect(byName.get("notes.txt")!.mtimeMs).toBeGreaterThan(0);
  expect(byName.get("sub")).toMatchObject({ kind: "dir" });
  expect(byName.get("pic.png")).toMatchObject({ kind: "file", textHint: false });
  expect(byName.get("link.txt")).toMatchObject({ kind: "symlink", targetKind: "file" });
  expect(byName.get("dangling")).toMatchObject({ kind: "symlink" });
  expect(byName.get("dangling")!.targetKind).toBeUndefined();

  expect(textHintFor("Makefile")).toBe(true);
  expect(textHintFor(".gitignore")).toBe(true);
  expect(textHintFor("archive.tar.gz")).toBe(false);
});

test("past the limit a listing says so rather than pretending", async () => {
  const dir = temp();
  for (let i = 0; i < 6; i += 1) writeFileSync(join(dir, `f${i}.txt`), String(i));
  const listing = await listDirectory(dir, 4);
  expect(listing.truncated).toBe(true);
  expect(listing.entries.length).toBe(4);
});

test("a latin1 file with accents is read as latin1 and written back byte for byte", async () => {
  const path = join(temp(), "accents.txt");
  const original = Buffer.from("café à l'île\nvélo très sûr\n", "latin1");
  writeFileSync(path, original);

  const read = await readFileWindow(path);
  expect(read.encoding).toBe("latin1");
  expect(read.eol).toBe("lf");
  expect(read.text).toBe("café à l'île\nvélo très sûr\n");
  expect(read.lines).toBe(2);

  const outcome = await writeTextFile({ path, text: read.text ?? "", etag: read.etag, encoding: read.encoding, eol: read.eol });
  expect(outcome.ok).toBe(true);
  expect(readFileSync(path).equals(original)).toBe(true);
});

test("a CRLF file round-trips: the editor's \\n normalization is undone on write", async () => {
  const path = join(temp(), "dos.txt");
  writeFileSync(path, "one\r\ntwo\r\nthree\r\n");
  const read = await readFileWindow(path);
  expect(read.eol).toBe("crlf");

  // What CodeMirror hands back is normalized to \n; the file's own ending is restored server-side.
  const normalized = (read.text ?? "").replace(/\r\n/g, "\n");
  const outcome = await writeTextFile({ path, text: normalized, etag: read.etag, encoding: "utf8", eol: "crlf" });
  expect(outcome.ok).toBe(true);
  expect(readFileSync(path, "utf8")).toBe("one\r\ntwo\r\nthree\r\n");
});

test("a UTF-8 BOM is stripped from the text and put back on write", async () => {
  const path = join(temp(), "bom.txt");
  const original = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("héllo\n", "utf8")]);
  writeFileSync(path, original);

  const read = await readFileWindow(path);
  expect(read.encoding).toBe("utf8-bom");
  expect(read.text).toBe("héllo\n");

  const outcome = await writeTextFile({ path, text: read.text ?? "", etag: read.etag, encoding: read.encoding, eol: "lf" });
  expect(outcome.ok).toBe(true);
  expect(readFileSync(path).equals(original)).toBe(true);
});

test("a UTF-16LE file is text, not the pile of NULs its bytes look like", async () => {
  const path = join(temp(), "wide.txt");
  const original = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("hi there\n", "utf16le")]);
  writeFileSync(path, original);

  const read = await readFileWindow(path);
  expect(read.binary).toBeUndefined();
  expect(read.encoding).toBe("utf16le");
  expect(read.text).toBe("hi there\n");
  expect(read.eol).toBe("lf");

  const outcome = await writeTextFile({ path, text: read.text ?? "", etag: read.etag, encoding: "utf16le", eol: "lf" });
  expect(outcome.ok).toBe(true);
  expect(readFileSync(path).equals(original)).toBe(true);
});

test("a NUL byte makes a file binary, and no text is returned", async () => {
  const path = join(temp(), "blob.dat");
  writeFileSync(path, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01, 0x02]));
  const read = await readFileWindow(path);
  expect(read.binary).toEqual({ reason: "nul" });
  expect(read.text).toBeUndefined();
  expect(read.encoding).toBeUndefined();
  expect(read.nextFrom).toBe(null);
});

test("control characters past 30% make a file binary; tabs, newlines and form feeds do not", async () => {
  const dir = temp();
  const noisy = join(dir, "noisy.bin");
  writeFileSync(noisy, Buffer.from([0x01, 0x02, 0x03, 0x04, 0x61, 0x62, 0x01, 0x02, 0x05]));
  expect((await readFileWindow(noisy)).binary).toEqual({ reason: "control" });

  const textish = join(dir, "tabs.txt");
  writeFileSync(textish, "col1\tcol2\r\npage\fbreak\n\n");
  const read = await readFileWindow(textish);
  expect(read.binary).toBeUndefined();
  expect(read.text).toBe("col1\tcol2\r\npage\fbreak\n\n");
});

test("a window cut mid-character aligns forward to a line start, and nothing is lost", async () => {
  const path = join(temp(), "wide-lines.txt");
  const line = "é😀Ünïcode line with accents\n";
  const original = line.repeat(40);
  writeFileSync(path, original, "utf8");
  const bytes = readFileSync(path);

  const first = await readFileWindow(path, 0, 10);
  expect(first.truncated).toBe(true);
  expect(first.nextFrom).not.toBe(null);
  expect(bytes[first.nextFrom! - 1]).toBe(0x0a);
  expect(first.text).toBe(bytes.subarray(0, first.nextFrom!).toString("utf8"));
  expect(first.text).not.toContain("\uFFFD");

  let text = first.text ?? "";
  let from: number | null = first.nextFrom;
  while (from !== null) {
    const next = await readFileWindow(path, from, 10);
    expect(next.from).toBe(from);
    text += next.text ?? "";
    from = next.nextFrom;
  }
  expect(text).toBe(original);
});

test("an empty tail window and an empty file both answer empty, not an error", async () => {
  const path = join(temp(), "short.txt");
  writeFileSync(path, "abc");
  const past = await readFileWindow(path, 99);
  expect(past.text).toBe("");
  expect(past.nextFrom).toBe(null);
  expect(past.truncated).toBe(false);
  expect(past.from).toBe(3);

  const emptyPath = join(temp(), "empty.txt");
  writeFileSync(emptyPath, "");
  const empty = await readFileWindow(emptyPath);
  expect(empty.text).toBe("");
  expect(empty.encoding).toBe("utf8");
  expect(empty.etag).toBe(`${empty.mtimeMs}-0`);
});

test("maxBytes is clamped to FS_READ_MAX at the top and to one byte at the bottom", async () => {
  const path = join(temp(), "clamp.txt");
  writeFileSync(path, "line one\nline two\n");
  const zero = await readFileWindow(path, 0, 0);
  expect(zero.text!.length).toBeGreaterThan(0);
  expect(FS_READ_MAX).toBe(2_000_000);
});

test("a stale etag is refused with the current state, and force overwrites", async () => {
  const path = join(temp(), "conflict.txt");
  writeFileSync(path, "one\n");
  const read = await readFileWindow(path);
  // The file changed between the read and the write: the agent edited it, or another window did.
  appendFileSync(path, "two\n");

  const refused = await writeTextFile({ path, text: "mine\n", etag: read.etag });
  expect(refused.ok).toBe(false);
  if (refused.ok) throw new Error("unreachable");
  expect(refused.conflict.etag).toBe((await readFileWindow(path)).etag);
  expect(readFileSync(path, "utf8")).toBe("one\ntwo\n");

  const forced = await writeTextFile({ path, text: "mine\n", etag: read.etag, force: true });
  expect(forced.ok).toBe(true);
  expect(readFileSync(path, "utf8")).toBe("mine\n");
});

test("a same-size rewrite still conflicts: the etag moves with the mtime", async () => {
  const path = join(temp(), "same-size.txt");
  writeFileSync(path, "aaaa\n");
  const read = await readFileWindow(path);
  writeFileSync(path, "bbbb\n");
  const now = statSync(path);
  utimesSync(path, now.atime, new Date(now.mtimeMs + 5000));

  const refused = await writeTextFile({ path, text: "cccc\n", etag: read.etag });
  expect(refused.ok).toBe(false);
  expect(readFileSync(path, "utf8")).toBe("bbbb\n");
});

test("the mode of the file a write replaces survives the atomic rename", async () => {
  const path = join(temp(), "mode.txt");
  writeFileSync(path, "x\n");
  chmodSync(path, 0o600);
  const read = await readFileWindow(path);
  await writeTextFile({ path, text: "y\n", etag: read.etag });
  expect(statSync(path).mode & 0o7777).toBe(0o600);
});

test.skipIf(process.getuid?.() === 0)("a write that cannot land leaves the old bytes and no temp file behind", async () => {
  const dir = guard();
  const path = join(dir, "locked.txt");
  writeFileSync(path, "old\n");
  const read = await readFileWindow(path);
  chmodSync(dir, 0o555);

  await expect(writeTextFile({ path, text: "new\n", etag: read.etag })).rejects.toThrow();
  chmodSync(dir, 0o755);
  expect(readFileSync(path, "utf8")).toBe("old\n");
  expect(readdirSync(dir)).toEqual(["locked.txt"]);
});

test("a latin1 file refuses text it cannot represent, writing nothing", async () => {
  const path = join(temp(), "l1.txt");
  const original = Buffer.from("café\n", "latin1");
  writeFileSync(path, original);
  const read = await readFileWindow(path);
  await expect(writeTextFile({ path, text: "emoji 😀\n", etag: read.etag, encoding: "latin1" })).rejects.toThrow(/latin1/);
  expect(readFileSync(path).equals(original)).toBe(true);
});

test("an empty etag on a missing file is the create case; a non-empty one is a deletion conflict", async () => {
  const path = join(temp(), "created.md");
  const created = await writeTextFile({ path, text: "# hi\n", etag: "" });
  expect(created.ok).toBe(true);
  if (!created.ok) throw new Error("unreachable");
  expect(readFileSync(path, "utf8")).toBe("# hi\n");
  expect(statSync(path).mode & 0o7777).toBe(0o644);

  rmSync(path);
  const stale = await writeTextFile({ path, text: "x\n", etag: created.etag });
  expect(stale.ok).toBe(false);
  if (stale.ok) throw new Error("unreachable");
  expect(stale.conflict.etag).toBe("");
  expect(existsSync(path)).toBe(false);
});

test("mkdir is one level deep and refuses what exists", async () => {
  const dir = temp();
  const path = join(dir, "sub");
  await makeDirectory(path);
  expect(statSync(path).isDirectory()).toBe(true);
  await expect(makeDirectory(path)).rejects.toThrow();
  // Not recursive: a missing parent is a typo, and a typo must not become a tree.
  await expect(makeDirectory(join(dir, "a", "b"))).rejects.toThrow();
  expect(existsSync(join(dir, "a"))).toBe(false);
});

test("a move refuses an existing destination, so nothing is silently replaced", async () => {
  const dir = temp();
  const from = join(dir, "from.txt");
  const to = join(dir, "to.txt");
  writeFileSync(from, "from");
  writeFileSync(to, "to");

  await expect(moveEntry(from, to)).rejects.toThrow(/exists/);
  expect(readFileSync(to, "utf8")).toBe("to");
  expect(readFileSync(from, "utf8")).toBe("from");

  const target = join(dir, "moved.txt");
  await moveEntry(from, target);
  expect(readFileSync(target, "utf8")).toBe("from");
  expect(existsSync(from)).toBe(false);
});

test("a directory needs recursive to go, and says so", async () => {
  const dir = temp();
  const tree = join(dir, "tree");
  mkdirSync(join(tree, "inner"), { recursive: true });
  writeFileSync(join(tree, "inner", "f.txt"), "x");

  await expect(removeEntry(tree, false)).rejects.toThrow(/recursive/);
  expect(existsSync(tree)).toBe(true);
  await removeEntry(tree, true);
  expect(existsSync(tree)).toBe(false);
});

test("the removal guards name their reason, follow symlinks, and each root stays", async () => {
  const root = temp();
  const home = join(root, "home");
  const data = join(root, "data");
  const workspace = join(root, "workspace");
  const cwd = join(root, "proj", "sub");
  for (const dir of [home, data, workspace, cwd]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(data, "keep.txt"), "keep");
  const guards = { home, myClawDir: data, defaultWorkspace: workspace, cwd };

  expect(await fsRemoveRefusal("/", guards)).toMatch(/filesystem root/);
  expect(await fsRemoveRefusal(home, guards)).toMatch(/home directory/);
  expect(await fsRemoveRefusal(data, guards)).toMatch(/my-claw data directory/);
  expect(await fsRemoveRefusal(workspace, guards)).toMatch(/workspace directory/);
  expect(await fsRemoveRefusal(join(root, "proj"), guards)).toMatch(/works inside/);
  expect(await fsRemoveRefusal(cwd, guards)).toMatch(/works inside/);

  // A symlink to a protected root is that root.
  const link = join(root, "link-to-data");
  symlinkSync(data, link);
  expect(await fsRemoveRefusal(link, guards)).toMatch(/my-claw data directory/);

  // Anything else is none of the guards' business.
  expect(await fsRemoveRefusal(join(root, "loose.txt"), guards)).toBe(null);
  expect(await fsRemoveRefusal(join(data, "..", "nothing-here"), guards)).toBe(null);
});

/** Pokes until the watcher reacts: Bun's fs.watch is not active when attach returns, so the first
 *  write can beat registration. The interval must exceed the watcher's debounce, or every poke
 *  re-arms its window and starves the push. */
async function pokeUntil(pred: () => boolean, poke: () => void, intervalMs = 80, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the watcher");
    try {
      poke();
    } catch {
      // the poke itself raced the test's own cleanup
    }
    await Bun.sleep(intervalMs);
  }
}

const settle = (ms: number) => Bun.sleep(ms);

test("a watch reports a change once per debounce window, and unwatch stops it", async () => {
  const dir = temp();
  const file = join(dir, "watched.txt");
  writeFileSync(file, "a");
  const registry = new FsWatchRegistry(40);
  const key = {};
  const events: Array<{ kind: string; size: number }> = [];
  expect(registry.watch(key, file, (change) => events.push(change))).toBe(true);
  expect(registry.count(key)).toBe(1);
  // One path, one watcher: watching it again is a no-op, not a second registration.
  expect(registry.watch(key, file, () => {})).toBe(true);
  expect(registry.count(key)).toBe(1);

  await pokeUntil(() => events.length > 0, () => appendFileSync(file, "x"));
  expect(events[0]!.kind).toBe("changed");
  // The emit stats at fire time, so the size is whatever the pokes left behind.
  expect(events[0]!.size).toBeGreaterThan(1);

  registry.unwatch(key, file);
  expect(registry.count(key)).toBe(0);
  const seen = events.length;
  appendFileSync(file, "y");
  await settle(120);
  appendFileSync(file, "z");
  await settle(120);
  expect(events.length).toBe(seen);
});

test("an atomic rename-over is a change and an unlink is a removal", async () => {
  const dir = temp();
  const file = join(dir, "live.log");
  writeFileSync(file, "one\n");
  const registry = new FsWatchRegistry(30);
  const key = {};
  const kinds: string[] = [];
  registry.watch(key, file, (change) => kinds.push(change.kind));

  await pokeUntil(
    () => kinds.includes("changed"),
    () => {
      writeFileSync(join(dir, ".swap"), "two\n");
      renameSync(join(dir, ".swap"), file);
    },
  );

  unlinkSync(file);
  await pokeUntil(() => kinds.includes("removed"), () => {});
  registry.drop(key);
  expect(registry.count(key)).toBe(0);
});

test("the watch cap is per connection, and drop closes everything it held", async () => {
  const dir = temp();
  const files = Array.from({ length: 9 }, (_, i) => join(dir, `w${i}.txt`));
  for (const file of files) writeFileSync(file, "x");
  const registry = new FsWatchRegistry(30);
  const a = {};
  const b = {};

  for (let i = 0; i < 9; i += 1) {
    expect(registry.watch(a, files[i]!, () => {})).toBe(i < 8);
  }
  expect(registry.count(a)).toBe(8);
  // The cap is per connection: a second socket still has its own eight.
  expect(registry.watch(b, files[8]!, () => {})).toBe(true);
  expect(registry.count(b)).toBe(1);

  registry.unwatch(a, files[0]!);
  expect(registry.count(a)).toBe(7);
  expect(registry.watch(a, files[8]!, () => {})).toBe(true);
  expect(registry.count(a)).toBe(8);

  registry.drop(a);
  expect(registry.count(a)).toBe(0);
  registry.clear();
  expect(registry.count(b)).toBe(0);
});

test("a watch on a path that cannot be attached is refused, not fatal", async () => {
  const registry = new FsWatchRegistry(30);
  expect(registry.watch({}, join(temp(), "missing", "file.txt"), () => {})).toBe(false);
});
