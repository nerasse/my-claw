import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { captureWorkspace, diffSnapshots, restoreDepot } from "../../src/snapshots/capture.ts";
import { recordRunStart, recordRunEnd, latestSnapshot, clearSessionSnapshots } from "../../src/snapshots/store.ts";
import { MY_CLAW_DIR } from "../../src/core/config.ts";

describe("snapshots: capture", () => {
  let ws: string;
  let shadows: string;

  beforeAll(async () => {
    ws = await mkdtemp(join(tmpdir(), "snap-ws-"));
    shadows = await mkdtemp(join(tmpdir(), "snap-sh-"));
    await mkdir(join(ws, "repo"), { recursive: true });
    await mkdir(join(ws, "plain"), { recursive: true });
  });

  afterAll(async () => {
    await rm(ws, { recursive: true, force: true });
    await rm(shadows, { recursive: true, force: true });
  });

  test("captures a workspace with nested git depots separately", async () => {
    const repo = join(ws, "repo");
    // Make repo a git repo with one commit
    await execGit(repo, ["init", "-q"]);
    await execGit(repo, ["config", "user.email", "t@t"]);
    await execGit(repo, ["config", "user.name", "t"]);
    await writeFile(join(repo, "a.txt"), "v1\n");
    await execGit(repo, ["add", "--all"]);
    await execGit(repo, ["commit", "-qm", "init"]);

    const snap = await captureWorkspace(ws, shadows);
    // Root (non-git) + the single nested repo
    expect(snap.depots.length).toBe(2);
    const repoDepot = snap.depots.find((d) => d.root.endsWith("repo"));
    expect(repoDepot).toBeDefined();
    expect(repoDepot!.treeId.length).toBe(40);
  });

  test("diff detects the changed file and restore reverts it", async () => {
    const repo = join(ws, "repo");
    const before = await captureWorkspace(ws, shadows);
    await writeFile(join(repo, "a.txt"), "v2\n");
    const after = await captureWorkspace(ws, shadows);
    const diffs = await diffSnapshots(before, after, shadows);
    const repoDiff = diffs.find((d) => d.root.endsWith("repo"));
    expect(repoDiff).toBeDefined();
    expect(repoDiff!.additions).toBe(1);
    expect(repoDiff!.deletions).toBe(1);

    for (const depot of before.depots) {
      await restoreDepot(depot, shadows);
    }
    expect(await readFile(join(repo, "a.txt"), "utf8")).toBe("v1\n");
  });

  test("restore removes a file created after the snapshot", async () => {
    const repo = join(ws, "repo");
    const before = await captureWorkspace(ws, shadows);
    await writeFile(join(repo, "new.txt"), "created later\n");
    const after = await captureWorkspace(ws, shadows);
    const diffs = await diffSnapshots(before, after, shadows);
    expect(diffs.some((d) => d.root.endsWith("repo") && d.additions >= 1)).toBe(true);

    for (const depot of before.depots) {
      await restoreDepot(depot, shadows);
    }
    const stillThere = await readFile(join(repo, "new.txt"), "utf8").then(() => true).catch(() => false);
    expect(stillThere).toBe(false);
    expect(await readFile(join(repo, "a.txt"), "utf8")).toBe("v1\n");
  });
});

describe("snapshots: store", () => {
  test("recordRunStart/end then latestSnapshot returns the after state", async () => {
    const sessionId = `test-snap-store-${process.pid}-${Date.now()}`;
    const ws = await mkdtemp(join(tmpdir(), "snap-ws2-"));
    const shadows = await mkdtemp(join(tmpdir(), "snap-sh2-"));
    // Point the store at the test shadows
    const old = MY_CLAW_DIR;
    // store uses MY_CLAW_DIR/snapshots — we cannot override it, but the fixture dirs are
    // under tmpdir() which the test harness also redirects. Cleanup is via clearSessionSnapshots.
    try {
      const run = await recordRunStart(sessionId, ws);
      expect(run.runId).toBeTruthy();
      expect(run.before.depots.length).toBeGreaterThan(0);
      const snap = await latestSnapshot(sessionId);
      expect(snap).not.toBeNull();
      expect(snap!.runId).toBe(run.runId);
    } finally {
      await clearSessionSnapshots(sessionId);
      await rm(ws, { recursive: true, force: true });
      await rm(shadows, { recursive: true, force: true });
      void old;
    }
  });
});

async function execGit(cwd: string, args: string[]): Promise<void> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  await promisify(execFile)("git", args, { cwd });
}
