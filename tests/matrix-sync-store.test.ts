import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ISyncResponse } from "matrix-js-sdk";
import { FileBackedMatrixSyncStore } from "../src/channels/matrix/file-sync-store.ts";

function createSyncResponse(nextBatch: string): ISyncResponse {
  return {
    next_batch: nextBatch,
    rooms: {
      join: {},
      invite: {},
      leave: {},
      knock: {},
    },
    account_data: { events: [] },
  };
}

test("FileBackedMatrixSyncStore only trusts clean shutdown state for restart replay", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "my-claw-matrix-sync-store-"));
  try {
    const storagePath = join(tempDir, "bot-storage.json");

    const firstStore = new FileBackedMatrixSyncStore(storagePath);
    assert.equal(firstStore.hasSavedSync(), false);

    await firstStore.setSyncData(createSyncResponse("s123"));
    await firstStore.flush();

    const afterDirtyPersist = new FileBackedMatrixSyncStore(storagePath);
    assert.equal(afterDirtyPersist.hasSavedSync(), true);
    assert.equal(afterDirtyPersist.hasSavedSyncFromCleanShutdown(), false);

    firstStore.markCleanShutdown();
    await firstStore.flush();

    const afterCleanShutdown = new FileBackedMatrixSyncStore(storagePath);
    assert.equal(afterCleanShutdown.hasSavedSync(), true);
    assert.equal(afterCleanShutdown.hasSavedSyncFromCleanShutdown(), true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("FileBackedMatrixSyncStore clears clean shutdown after fresh sync data", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "my-claw-matrix-sync-store-"));
  try {
    const storagePath = join(tempDir, "bot-storage.json");

    const firstStore = new FileBackedMatrixSyncStore(storagePath);
    await firstStore.setSyncData(createSyncResponse("s123"));
    firstStore.markCleanShutdown();
    await firstStore.flush();

    const restartedStore = new FileBackedMatrixSyncStore(storagePath);
    assert.equal(restartedStore.hasSavedSyncFromCleanShutdown(), true);

    await restartedStore.setSyncData(createSyncResponse("s456"));
    await restartedStore.flush();

    const afterNewSync = new FileBackedMatrixSyncStore(storagePath);
    assert.equal(afterNewSync.hasSavedSync(), true);
    assert.equal(afterNewSync.hasSavedSyncFromCleanShutdown(), false);
    assert.equal(await afterNewSync.getSavedSyncToken(), "s456");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
