import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMatrixInboundEventDeduper } from "../src/channels/matrix/inbound-dedupe.ts";

test("Matrix inbound deduper persists committed events across restarts", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "my-claw-matrix-dedupe-"));
  try {
    const storagePath = join(tempDir, "inbound-dedupe.json");
    const first = await createMatrixInboundEventDeduper({ storagePath });

    assert.equal(first.claimEvent({ roomId: "!room:test", eventId: "$evt1" }), true);
    await first.commitEvent({ roomId: "!room:test", eventId: "$evt1" });
    await first.stop();

    const second = await createMatrixInboundEventDeduper({ storagePath });
    assert.equal(second.claimEvent({ roomId: "!room:test", eventId: "$evt1" }), false);
    await second.stop();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("Matrix inbound deduper allows retry after release without commit", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "my-claw-matrix-dedupe-"));
  try {
    const storagePath = join(tempDir, "inbound-dedupe.json");
    const deduper = await createMatrixInboundEventDeduper({ storagePath });

    assert.equal(deduper.claimEvent({ roomId: "!room:test", eventId: "$evt2" }), true);
    deduper.releaseEvent({ roomId: "!room:test", eventId: "$evt2" });
    assert.equal(deduper.claimEvent({ roomId: "!room:test", eventId: "$evt2" }), true);

    await deduper.stop();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("Matrix inbound deduper blocks a second live claimant until release", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "my-claw-matrix-dedupe-"));
  try {
    const storagePath = join(tempDir, "inbound-dedupe.json");
    const first = await createMatrixInboundEventDeduper({ storagePath });
    const second = await createMatrixInboundEventDeduper({ storagePath });

    assert.equal(first.claimEvent({ roomId: "!room:test", eventId: "$evt3" }), true);
    assert.equal(second.claimEvent({ roomId: "!room:test", eventId: "$evt3" }), false);

    first.releaseEvent({ roomId: "!room:test", eventId: "$evt3" });
    assert.equal(second.claimEvent({ roomId: "!room:test", eventId: "$evt3" }), true);

    await first.stop();
    await second.stop();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
