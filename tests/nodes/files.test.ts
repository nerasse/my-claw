/**
 * The bytes crossing between a node and this server -- docs/remote-nodes.md.
 *
 * Uploads are the only paths a frame from another machine may name, and a ticket is redeemed
 * once by the node it was minted for.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { MY_CLAW_DIR } from "../../src/core/config.ts";
import { isNodeUploadPath, openFileTicket, resetNodeFiles, storeNodeUpload, takeFileTicket } from "../../src/nodes/files.ts";

beforeEach(async () => {
  resetNodeFiles();
  await rm(join(MY_CLAW_DIR, "nodes"), { recursive: true, force: true });
});

describe("node uploads", () => {
  test("a file lands under the node's own directory, and only there counts as its own", async () => {
    const upload = await storeNodeUpload("node-1", "render.png", new Uint8Array([1, 2, 3]));
    expect(upload.filename).toBe("render.png");
    expect(upload.path.startsWith(join(MY_CLAW_DIR, "nodes", "files", "node-1"))).toBe(true);
    expect(isNodeUploadPath("node-1", upload.path)).toBe(true);
    // Another node's claim on the same path is not theirs, and neither is the config file.
    expect(isNodeUploadPath("node-2", upload.path)).toBe(false);
    expect(isNodeUploadPath("node-1", join(MY_CLAW_DIR, "config.json"))).toBe(false);
  });

  test("a file name from another machine cannot walk paths", async () => {
    const upload = await storeNodeUpload("node-1", "../../etc/passwd", new Uint8Array([1]));
    expect(upload.path).not.toContain("..");
    expect(upload.filename).toBe("passwd");
    expect(isNodeUploadPath("node-1", upload.path)).toBe(true);
  });

  test("an empty upload is refused", async () => {
    await expect(storeNodeUpload("node-1", "x", new Uint8Array())).rejects.toThrow("empty upload");
  });
});

describe("file tickets", () => {
  test("a ticket is redeemed once, by the node it was minted for", () => {
    const ticket = openFileTicket("node-1", "/srv/assets/texture.png");
    expect(ticket.url).toBe(`/node/file/${ticket.id}`);
    expect(takeFileTicket(ticket.id, "node-2")).toEqual({ ok: false, error: "ticket belongs to another node" });
    // A refused redemption does not burn the ticket: the node it belongs to still gets it.
    expect(takeFileTicket(ticket.id, "node-1")).toEqual({ ok: true, path: "/srv/assets/texture.png" });
    expect(takeFileTicket(ticket.id, "node-1")).toEqual({ ok: false, error: "unknown ticket" });
  });

  test("an unknown ticket is refused", () => {
    expect(takeFileTicket("nope", "node-1")).toEqual({ ok: false, error: "unknown ticket" });
  });
});
