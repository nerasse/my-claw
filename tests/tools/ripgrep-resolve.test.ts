/**
 * Which `rg` the search tool trusts.
 *
 * Existence was the whole check until 0.7.207 shipped a binary without its mode bits and every
 * `search` on that install died at the spawn with `EACCES` (two measured calls, 2026-11-23). A
 * present-but-unrunnable file must not resolve as the engine.
 */

import { test } from "bun:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, stat } from "node:fs/promises";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveRipgrep, ripgrepExeName } from "../../src/tools/ripgrep.ts";

test("resolveRipgrep: an rg that lost its execute bit is repaired, not trusted as is", async () => {
  const dir = await mkdtemp(join(tmpdir(), "my-claw-rg-resolve-"));
  const exe = join(dir, ripgrepExeName());
  await writeFile(exe, "#!/bin/sh\nexit 0\n", { mode: 0o644 });
  await chmod(exe, 0o644);

  const found = await resolveRipgrep({ vendorDir: dir, allowDownload: false });

  assert.ok(found, "the vendor binary is present and executable after the repair");
  assert.equal(found.path, exe);
  const mode = (await stat(exe)).mode & 0o777;
  assert.equal(mode & 0o100, 0o100, "the owner execute bit is set");
});

test("resolveRipgrep: a directory named like the binary is not an engine", async () => {
  const dir = await mkdtemp(join(tmpdir(), "my-claw-rg-dir-"));
  await mkdir(join(dir, ripgrepExeName()), { recursive: true });

  const found = await resolveRipgrep({ vendorDir: dir, cacheDir: null, allowDownload: false });

  // Either nothing, or whatever the machine already has on PATH: never the directory.
  assert.notEqual(found?.source, "vendor");
});
