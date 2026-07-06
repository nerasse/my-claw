import { test, expect } from "bun:test";
import { writeFile, access, unlink, mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupGeneratedTempFiles } from "../../src/utils/media.ts";

const exists = async (p: string) => {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
};

test("cleanupGeneratedTempFiles removes generated /tmp files but leaves others alone", async () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const ttsFile = `/tmp/tts-${suffix}.mp3`;
  const browserFile = `/tmp/browser-${suffix}.png`;
  const userFile = `/tmp/other-${suffix}.png`;

  await writeFile(ttsFile, "a");
  await writeFile(browserFile, "b");
  await writeFile(userFile, "c");

  try {
    await cleanupGeneratedTempFiles([
      { path: ttsFile },
      { path: browserFile },
      { path: userFile },
      { path: undefined },
    ]);

    expect(await exists(ttsFile)).toBe(false);
    expect(await exists(browserFile)).toBe(false);
    expect(await exists(userFile)).toBe(true);
  } finally {
    await unlink(userFile).catch(() => {});
    await unlink(ttsFile).catch(() => {});
    await unlink(browserFile).catch(() => {});
  }
});

test("cleanupGeneratedTempFiles removes the whole tts-* directory, not just the file", async () => {
  // Real TTS output: mkdtemp(tmpdir()/tts-)/output.mp3 — the empty dir must not survive cleanup.
  const dir = await mkdtemp(join(tmpdir(), "tts-"));
  const file = join(dir, "output.mp3");
  await writeFile(file, "audio");

  await cleanupGeneratedTempFiles([{ path: file }]);

  expect(await exists(file)).toBe(false);
  expect(await exists(dir)).toBe(false);
});

test("cleanupGeneratedTempFiles tolerates empty input and missing files", async () => {
  await cleanupGeneratedTempFiles();
  await cleanupGeneratedTempFiles([]);
  await cleanupGeneratedTempFiles([{ path: "/tmp/tts-does-not-exist-xyz.mp3" }]);
});
