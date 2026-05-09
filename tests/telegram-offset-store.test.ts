import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  createTelegramUpdateDeduper,
  readTelegramUpdateOffset,
  resolveTelegramUpdateOffsetPath,
  writeTelegramUpdateOffset,
} from "../src/channels/telegram-offset-store.ts";

const TOKEN = "99:test-token";

test("Telegram update deduper persists committed updates across restarts", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "my-claw-telegram-dedupe-"));
  try {
    const first = await createTelegramUpdateDeduper({ token: TOKEN, rootDir: tempDir });

    assert.equal(first.claimUpdate(10), true);
    await first.commitUpdate(TOKEN, 10);
    await first.stop();

    const second = await createTelegramUpdateDeduper({ token: TOKEN, rootDir: tempDir });
    assert.equal(second.claimUpdate(10), false);
    assert.equal(await readTelegramUpdateOffset(TOKEN, tempDir), 10);
    await second.stop();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("Telegram update deduper allows retry after release without commit", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "my-claw-telegram-dedupe-"));
  try {
    const deduper = await createTelegramUpdateDeduper({ token: TOKEN, rootDir: tempDir });

    assert.equal(deduper.claimUpdate(11), true);
    deduper.releaseUpdate(11);
    assert.equal(deduper.claimUpdate(11), true);

    await deduper.stop();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("Telegram update deduper blocks a second live claimant until release", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "my-claw-telegram-dedupe-"));
  try {
    const first = await createTelegramUpdateDeduper({ token: TOKEN, rootDir: tempDir });
    const second = await createTelegramUpdateDeduper({ token: TOKEN, rootDir: tempDir });

    assert.equal(first.claimUpdate(12), true);
    assert.equal(second.claimUpdate(12), false);

    first.releaseUpdate(12);
    assert.equal(second.claimUpdate(12), true);

    await first.stop();
    await second.stop();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("Telegram update offset store rejects mismatched bot ids", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "my-claw-telegram-dedupe-"));
  try {
    const path = resolveTelegramUpdateOffsetPath(TOKEN, tempDir);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ version: 1, lastUpdateId: 42, botId: "100" }, null, 2));
    assert.equal(await readTelegramUpdateOffset(TOKEN, tempDir), null);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("Telegram update offset store persists token-bound update ids", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "my-claw-telegram-dedupe-"));
  try {
    await writeTelegramUpdateOffset(TOKEN, 42, tempDir);
    assert.equal(await readTelegramUpdateOffset(TOKEN, tempDir), 42);
    assert.match(resolveTelegramUpdateOffsetPath(TOKEN, tempDir), /telegram\/accounts\/99\//);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
