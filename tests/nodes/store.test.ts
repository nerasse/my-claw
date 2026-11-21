import { describe, test, expect, beforeEach, setSystemTime } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import {
  findNodeByToken,
  mintNode,
  nodeAsksFirst,
  nodeRecord,
  nodeRecords,
  nodesFilePath,
  revokeNode,
  resetNodesStore,
  setNodeAccess,
  setNodeFacts,
  touchNode,
} from "../../src/nodes/store.ts";
import type { NodeFacts } from "../../src/nodes/types.ts";

const FACTS: NodeFacts = {
  os: "linux",
  arch: "x64",
  hostname: "web01",
  user: "neras",
  mode: "admin",
  version: "0.1.0",
  tools: [{ name: "bash", description: "Run a command", parameters: { type: "object", properties: {} } }],
};

beforeEach(async () => {
  await resetNodesStore();
  await rm(nodesFilePath(), { force: true });
});

describe("node store", () => {
  test("mints a record, keeps only the token hash, and finds it by token", async () => {
    const minted = await mintNode({ name: "web01", facts: FACTS });
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;

    expect(minted.minted.record.nodeId).toMatch(/^node-[0-9a-f]{8}$/);
    const stored = nodeRecord(minted.minted.record.nodeId);
    expect(stored?.name).toBe("web01");
    expect(stored?.tokenHash).toBeString();
    expect(stored?.tokenHash).not.toBe(minted.minted.token);

    expect(findNodeByToken(minted.minted.token)?.nodeId).toBe(minted.minted.record.nodeId);
    expect(findNodeByToken("not-the-token")).toBeUndefined();

    // On disk too, with the token never written in clear.
    const raw = await readFile(nodesFilePath(), "utf-8");
    expect(raw).toContain(minted.minted.record.nodeId);
    expect(raw).not.toContain(minted.minted.token);
  });

  test("refuses a second node under the same name, whatever the case", async () => {
    expect((await mintNode({ name: "web01", facts: FACTS })).ok).toBe(true);
    const second = await mintNode({ name: "WEB01", facts: FACTS });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toContain("already exists");
  });

  test("a paired machine asks first, and only the owner's false is ever stored", async () => {
    const minted = await mintNode({ name: "web01", facts: FACTS });
    if (!minted.ok) throw new Error("mint failed");
    const nodeId = minted.minted.record.nodeId;
    expect(nodeRecord(nodeId)?.approval).toBeUndefined();
    expect(nodeAsksFirst(nodeRecord(nodeId))).toBe(true);

    await setNodeAccess(nodeId, { approval: false });
    expect(nodeRecord(nodeId)?.approval).toBe(false);
    expect(nodeAsksFirst(nodeRecord(nodeId))).toBe(false);
    expect(await readFile(nodesFilePath(), "utf-8")).toContain('"approval": false');

    await setNodeAccess(nodeId, { approval: true });
    expect(nodeRecord(nodeId)?.approval).toBeUndefined();
    expect(nodeAsksFirst(nodeRecord(nodeId))).toBe(true);
  });

  test("a record written before the default flipped asks too, with or without its flag", () => {
    expect(nodeAsksFirst({ nodeId: "node-a", name: "a", tokenHash: "00", createdAt: "2026-10-20T00:00:00.000Z" })).toBe(true);
    expect(nodeAsksFirst({ nodeId: "node-b", name: "b", tokenHash: "00", createdAt: "2026-10-20T00:00:00.000Z", approval: true })).toBe(true);
    expect(nodeAsksFirst(undefined)).toBe(true);
  });

  test("a revoke removes the record and invalidates its token", async () => {
    const minted = await mintNode({ name: "web01", facts: FACTS });
    if (!minted.ok) throw new Error("mint failed");
    expect(await revokeNode(minted.minted.record.nodeId)).toBe(true);
    expect(nodeRecord(minted.minted.record.nodeId)).toBeUndefined();
    expect(findNodeByToken(minted.minted.token)).toBeUndefined();
    expect(await revokeNode(minted.minted.record.nodeId)).toBe(false);
  });

  test("facts from a hello replace the stored ones and move lastSeenAt", async () => {
    // A millisecond clock makes this a race on a fast runner: the mint and the hello land in the
    // same millisecond, and the timestamp legitimately does not move. Pin the clock here.
    setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    try {
      const minted = await mintNode({ name: "web01", facts: FACTS });
      if (!minted.ok) throw new Error("mint failed");
      const before = nodeRecord(minted.minted.record.nodeId)!.lastSeenAt;

      setSystemTime(new Date("2026-01-01T00:00:01.000Z"));
      const updated: NodeFacts = { ...FACTS, hostname: "web01b", tools: [] };
      await setNodeFacts(minted.minted.record.nodeId, updated);
      const record = nodeRecord(minted.minted.record.nodeId)!;
      expect(record.facts?.hostname).toBe("web01b");
      expect(record.lastSeenAt).toBeString();
      expect(record.lastSeenAt).not.toBe(before);
    } finally {
      setSystemTime();
    }
  });

  test("a touch inside the window does not rewrite the file", async () => {
    const minted = await mintNode({ name: "web01", facts: FACTS });
    if (!minted.ok) throw new Error("mint failed");
    const record = nodeRecord(minted.minted.record.nodeId)!;
    const seen = record.lastSeenAt;

    await touchNode(minted.minted.record.nodeId);
    expect(nodeRecord(minted.minted.record.nodeId)?.lastSeenAt).toBe(seen);
  });

  test("records are listed by name", async () => {
    await mintNode({ name: "zeta", facts: FACTS });
    await mintNode({ name: "alpha", facts: FACTS });
    expect(nodeRecords().map((r) => r.name)).toEqual(["alpha", "zeta"]);
  });

  test("a file written by hand into nonsense is read as an empty set, not a crash", async () => {
    const { writeFile, mkdir } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    await mkdir(dirname(nodesFilePath()), { recursive: true });
    await writeFile(nodesFilePath(), "{ not json");
    await resetNodesStore();
    expect(nodeRecords()).toEqual([]);
  });
});
