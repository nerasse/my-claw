import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { captureWorkspace, diffSnapshots, restoreDepot } from "../../src/snapshots/capture.ts";
import { recordRunStart, snapshotOfRuns, clearSessionSnapshots, pruneSessionSnapshots, gcShadows, snapshotsRoot } from "../../src/snapshots/store.ts";
import { MY_CLAW_DIR } from "../../src/core/config.ts";

describe("snapshots: capture", () => {
  let ws: string;
  let shadows: string;

  // The fixture belongs here, not to whichever test ran first. The repo used to be created by
  // "captures a workspace with nested git depots separately", and the two tests below silently
  // depended on it having run: under --randomize either of them could go first, find no depot to
  // diff, and fail for a reason neither is about. Each test now restores the repo to this state on
  // its way out, so any order works.
  beforeAll(async () => {
    ws = await mkdtemp(join(tmpdir(), "snap-ws-"));
    shadows = await mkdtemp(join(tmpdir(), "snap-sh-"));
    await mkdir(join(ws, "repo"), { recursive: true });
    await mkdir(join(ws, "plain"), { recursive: true });

    const repo = join(ws, "repo");
    await execGit(repo, ["init", "-q"]);
    await execGit(repo, ["config", "user.email", "t@t"]);
    await execGit(repo, ["config", "user.name", "t"]);
    await writeFile(join(repo, "a.txt"), "v1\n");
    await execGit(repo, ["add", "--all"]);
    await execGit(repo, ["commit", "-qm", "init"]);
  });

  afterAll(async () => {
    await rm(ws, { recursive: true, force: true });
    await rm(shadows, { recursive: true, force: true });
  });

  test("captures a workspace with nested git depots separately", async () => {
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

describe("snapshots: a depot that cannot be captured", () => {
  test("is left out, and the depot after it is still captured", async () => {
    // The failed depot used to be spliced out of the list the loop was walking: the next one was
    // skipped, and stayed in the snapshot with an empty tree a restore cannot read. The root is
    // the one broken here because it is always first in the list; the discovery order of the
    // nested depots is the directory's, not the alphabet's.
    const ws = await mkdtemp(join(tmpdir(), "snap-ws5-"));
    const shadows = await mkdtemp(join(tmpdir(), "snap-sh5-"));
    try {
      const repo = join(ws, "nested");
      await mkdir(repo, { recursive: true });
      await execGit(repo, ["init", "-q"]);
      await writeFile(join(repo, "file.txt"), "nested\n");
      await writeFile(join(ws, "secret.txt"), "unreadable\n");
      await chmod(join(ws, "secret.txt"), 0o000);

      const snap = await captureWorkspace(ws, shadows);

      expect(snap.depots.map((depot) => depot.root)).toEqual([repo]);
      expect(snap.depots[0]!.treeId).toHaveLength(40);
    } finally {
      await chmod(join(ws, "secret.txt"), 0o644).catch(() => {});
      await rm(ws, { recursive: true, force: true });
      await rm(shadows, { recursive: true, force: true });
    }
  });
});

describe("snapshots: store", () => {
  test("a run's snapshot is found by the run id its marker carries, and recorded once", async () => {
    const sessionId = `test-snap-store-${process.pid}-${Date.now()}`;
    const ws = await mkdtemp(join(tmpdir(), "snap-ws2-"));
    const shadows = await mkdtemp(join(tmpdir(), "snap-sh2-"));
    // Point the store at the test shadows
    const old = MY_CLAW_DIR;
    // store uses MY_CLAW_DIR/snapshots — we cannot override it, but the fixture dirs are
    // under tmpdir() which the test harness also redirects. Cleanup is via clearSessionSnapshots.
    try {
      const run = await recordRunStart(sessionId, ws, "run-a");
      expect(run.runId).toBe("run-a");
      expect(run.before.depots.length).toBeGreaterThan(0);
      // The same run recording again (a retry inside it) keeps the earliest state.
      await writeFile(join(ws, "later.txt"), "later\n");
      const again = await recordRunStart(sessionId, ws, "run-a");
      expect(again.before).toEqual(run.before);
      const snap = await snapshotOfRuns(sessionId, ["unknown", "run-a"]);
      expect(snap!.runId).toBe("run-a");
      expect(await snapshotOfRuns(sessionId, ["unknown"])).toBeNull();
    } finally {
      await clearSessionSnapshots(sessionId);
      await rm(ws, { recursive: true, force: true });
      await rm(shadows, { recursive: true, force: true });
      void old;
    }
  });

  test("keeps the recent runs of a session and drops what undo can no longer reach", async () => {
    // Nothing used to delete these. They are the index of the shadow objects, so the retention is
    // decided here and the object prune follows it -- 247 MB of shadows nothing had ever pruned.
    const sessionId = `test-snap-prune-${process.pid}-${Date.now()}`;
    const ws = await mkdtemp(join(tmpdir(), "snap-ws3-"));
    const dir = join(snapshotsRoot(), "session", sessionId);
    try {
      await mkdir(dir, { recursive: true });
      const now = Date.now();
      // 25 runs today, and one from last spring.
      for (let i = 0; i < 25; i++) {
        await writeFile(join(dir, `run-${i}.json`), JSON.stringify({ runId: `run-${i}`, sessionId, before: null, after: null, ts: now - i * 1000 }), "utf8");
      }
      await writeFile(join(dir, "ancient.json"), JSON.stringify({ runId: "ancient", sessionId, before: null, after: null, ts: now - 90 * 24 * 3600 * 1000 }), "utf8");

      await pruneSessionSnapshots(sessionId);

      const left = (await readdir(dir)).sort();
      expect(left).toHaveLength(20);
      expect(left).toContain("run-0.json");
      expect(left).not.toContain("run-20.json");
      expect(left).not.toContain("ancient.json");
    } finally {
      await clearSessionSnapshots(sessionId);
      await rm(ws, { recursive: true, force: true });
    }
  });

  test("the shadow gc runs over every shadow and leaves a fresh capture readable", async () => {
    // A capture writes blobs and trees and no commit, so every object is unreachable and a plain
    // `git gc` would take the lot. The prune window is what keeps a live snapshot readable.
    const sessionId = `test-snap-gc-${process.pid}-${Date.now()}`;
    const ws = await mkdtemp(join(tmpdir(), "snap-ws4-"));
    try {
      await writeFile(join(ws, "note.txt"), "avant", "utf8");
      const run = await recordRunStart(sessionId, ws, "run-gc");
      const treeBefore = run.before.depots[0]?.treeId;
      expect(treeBefore).toBeTruthy();

      await gcShadows();

      // Still there: the object is younger than the prune window.
      const snap = await snapshotOfRuns(sessionId, ["run-gc"]);
      expect(snap!.before.depots[0]!.treeId).toBe(treeBefore!);
    } finally {
      await clearSessionSnapshots(sessionId);
      await rm(ws, { recursive: true, force: true });
    }
  });
});

async function execGit(cwd: string, args: string[]): Promise<void> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  await promisify(execFile)("git", args, { cwd });
}