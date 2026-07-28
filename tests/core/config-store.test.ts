import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { writeFile, readFile, rm, mkdir, stat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { MY_CLAW_DIR, CONFIG_PATH } from "../../src/core/config.ts";
import * as store from "../../src/core/config-store.ts";

// MY_CLAW_DIR is fixed by tests/setup.ts before any src module loads, so the store is used as-is
// and the shared dir is cleaned between tests instead of being redirected per test.
const dir = MY_CLAW_DIR;
const storeRoot = join(dir, "backups");

const VALID = JSON.stringify({ llm: { defaultModel: "a" }, channels: {} }, null, 2);

beforeEach(async () => {
  await rm(storeRoot, { recursive: true, force: true });
  await rm(join(dir, "skills"), { recursive: true, force: true });
  await rm(join(dir, "tools.d"), { recursive: true, force: true });
  await rm(CONFIG_PATH, { force: true });
});

afterEach(async () => {
  await rm(storeRoot, { recursive: true, force: true });
  await rm(CONFIG_PATH, { force: true });
});

async function target(content = VALID, name = "config.json"): Promise<string> {
  const p = join(dir, name);
  await writeFile(p, content);
  return p;
}

describe("config store", () => {
  test("snapshot writes once and dedups identical content", async () => {
    const p = await target();
    const first = await store.snapshot(p, { origin: "boot" });
    const second = await store.snapshot(p, { origin: "boot" });
    expect(first).not.toBeNull();
    expect(second).toBe(first);
    expect(await store.history(p)).toHaveLength(1);
  });

  test("a changed file produces a second snapshot", async () => {
    const p = await target();
    await store.snapshot(p, { origin: "boot" });
    await writeFile(p, JSON.stringify({ llm: { defaultModel: "b" } }));
    await store.snapshot(p, { origin: "reload" });
    expect(await store.history(p)).toHaveLength(2);
  });

  test("a missing file snapshots to nothing instead of throwing", async () => {
    expect(await store.snapshot(join(dir, "absent.json"), { origin: "boot" })).toBeNull();
  });

  test("confirm marks the newest, and latestConfirmed returns its content", async () => {
    const p = await target();
    await store.snapshot(p, { origin: "boot" });
    const ref = await store.confirm(p);
    expect(ref).not.toBeNull();

    const good = await store.latestConfirmed(p);
    expect(good?.ref).toBe(ref!);
    expect(good?.content).toBe(VALID);
    expect((await store.history(p)).find((e) => e.confirmed)?.ref).toBe(ref!);
  });

  test("an unconfirmed newer snapshot never becomes the fallback", async () => {
    const p = await target();
    await store.snapshot(p, { origin: "boot" });
    await store.confirm(p);

    // Simulates the pre-write path: content that was on disk but never proved it runs.
    await writeFile(p, JSON.stringify({ llm: { defaultModel: "never-ran" } }));
    await store.snapshot(p, { origin: "pre-write" });

    const good = await store.latestConfirmed(p);
    expect(good?.content).toBe(VALID);
    expect(await store.history(p)).toHaveLength(2);
  });

  test("latestConfirmed is null until the health gate has run", async () => {
    const p = await target();
    await store.snapshot(p, { origin: "boot" });
    expect(await store.latestConfirmed(p)).toBeNull();
  });

  test("mode 0600 survives snapshot and restore", async () => {
    const p = join(dir, ".env");
    await writeFile(p, "TOKEN=abc\n", { mode: 0o600 });
    const ref = await store.snapshot(p, { origin: "boot" });
    const snapPath = join(dir, "backups", store.artifactId(p), ref!);
    expect((await stat(snapPath)).mode & 0o777).toBe(0o600);

    await writeFile(p, "TOKEN=changed\n", { mode: 0o600 });
    const res = await store.restore(p, ref!);
    expect(res.ok).toBe(true);
    expect(await readFile(p, "utf-8")).toBe("TOKEN=abc\n");
    expect((await stat(p)).mode & 0o777).toBe(0o600);
  });

  test("restore archives the overwritten state so the rollback is undoable", async () => {
    const p = await target();
    const first = await store.snapshot(p, { origin: "boot" });
    const edited = JSON.stringify({ llm: { defaultModel: "edited" } });
    await writeFile(p, edited);

    await store.restore(p, first!);
    expect(await readFile(p, "utf-8")).toBe(VALID);

    const preRollback = (await store.history(p)).find((e) => e.ref !== first);
    expect(preRollback).toBeDefined();
    expect(await store.readSnapshot(p, preRollback!.ref)).toBe(edited);
  });

  test("restore of an unknown ref fails without touching the file", async () => {
    const p = await target();
    const res = await store.restore(p, "20260101-000000000-aaaaaaaaaaaa");
    expect(res.ok).toBe(false);
    expect(await readFile(p, "utf-8")).toBe(VALID);
  });

  test("a section merge restores one subtree and preserves later edits", async () => {
    const p = await target(JSON.stringify({ llm: { defaultModel: "old" }, voice: { mode: "auto" } }));
    const ref = await store.snapshot(p, { origin: "boot" });
    await writeFile(p, JSON.stringify({ llm: { defaultModel: "new" }, voice: { mode: "cloud" } }));

    await store.restore(p, ref!, (snap, current) => {
      const from = JSON.parse(snap) as Record<string, unknown>;
      const into = JSON.parse(current) as Record<string, unknown>;
      into["llm"] = from["llm"];
      return JSON.stringify(into);
    });

    const after = JSON.parse(await readFile(p, "utf-8")) as Record<string, Record<string, string>>;
    expect(after["llm"]!["defaultModel"]).toBe("old");
    expect(after["voice"]!["mode"]).toBe("cloud");
  });

  test("rejected content is archived with its error and deduped", async () => {
    const p = await target();
    expect(await store.reject(p, "{ broken", "Invalid JSON")).not.toBeNull();
    expect(await store.reject(p, "{ broken", "Invalid JSON")).toBeNull();
    const files = await readdir(join(dir, "backups", store.artifactId(p), "rejected"));
    expect(files).toHaveLength(1);
    expect(await readFile(join(dir, "backups", store.artifactId(p), "rejected", files[0]!), "utf-8")).toBe("{ broken");
  });

  test("purge keeps the confirmed snapshot even when it is the oldest", async () => {
    const p = await target();
    await store.snapshot(p, { origin: "boot" });
    await store.confirm(p);
    const confirmedRef = (await store.history(p)).find((e) => e.confirmed)!.ref;

    // 25 further versions: past the 20-generation ceiling.
    for (let i = 0; i < 25; i++) {
      await writeFile(p, JSON.stringify({ llm: { defaultModel: `v${i}` } }));
      await store.snapshot(p, { origin: "reload" });
    }

    const entries = await store.history(p);
    expect(entries.length).toBeLessThanOrEqual(21);
    expect(entries.some((e) => e.ref === confirmedRef)).toBe(true);
    expect(await store.latestConfirmed(p)).not.toBeNull();
  });

  test("the journal records one line per event and survives a torn line", async () => {
    const p = await target();
    await store.snapshot(p, { origin: "boot" });
    await store.confirm(p);
    const journalPath = join(dir, "backups", "journal.jsonl");
    const lines = (await readFile(journalPath, "utf-8")).trim().split("\n");
    expect(lines.length).toBe(2);
    expect((JSON.parse(lines[0]!) as { event: string }).event).toBe("snapshot");
    expect((JSON.parse(lines[1]!) as { event: string }).event).toBe("confirm");

    await writeFile(journalPath, `${lines.join("\n")}\n{"ts":1,"event":"tor`);
    // A torn tail must not stop new events from being appended.
    await writeFile(p, JSON.stringify({ llm: {} }));
    await store.snapshot(p, { origin: "reload" });
    expect((await readFile(journalPath, "utf-8")).split("\n").length).toBeGreaterThan(3);
  });

  test("isTracked only reports files that already have snapshots", async () => {
    const p = await target();
    expect(await store.isTracked(p)).toBe(false);
    await store.snapshot(p, { origin: "boot" });
    expect(await store.isTracked(p)).toBe(true);
  });

  test("artifactId is derived from the path and stays filename-safe", async () => {
    expect(store.artifactId(join(dir, "config.json"))).toBe("config.json");
    expect(store.artifactId(join(dir, "skills", "forgejo", "SKILL.md"))).toBe("skills_forgejo_SKILL.md");
  });

  test("protectedPaths covers the core files plus discovered skills and plugins", async () => {
    await mkdir(join(dir, "skills", "forgejo"), { recursive: true });
    await writeFile(join(dir, "skills", "forgejo", "SKILL.md"), "---\nname: f\ndescription: d\n---\nx");
    await mkdir(join(dir, "tools.d"), { recursive: true });
    await writeFile(join(dir, "tools.d", "extra.ts"), "export const tool = {};");
    const ws = join(dir, "workspace");
    await mkdir(ws, { recursive: true });

    const paths = await store.protectedPaths(ws);
    expect(paths).toContain(join(dir, "config.json"));
    expect(paths).toContain(join(dir, ".env"));
    expect(paths).toContain(join(dir, "cron", "jobs.json"));
    expect(paths).toContain(join(ws, "SOUL.md"));
    expect(paths).toContain(join(dir, "skills", "forgejo", "SKILL.md"));
    expect(paths).toContain(join(dir, "tools.d", "extra.ts"));
    // Data and caches stay out: restoring them would be worse than losing them.
    expect(paths.some((p) => p.includes("memory.db") || p.includes("model-catalog"))).toBe(false);
  });
});

describe("boot fallback", () => {
  test("a broken config.json boots from the confirmed snapshot and keeps the broken file", async () => {
    const p = await target();
    await store.snapshot(p, { origin: "boot" });
    await store.confirm(p);

    await writeFile(p, "{ this is not json");
    const { config, fallback } = await store.loadConfigOrFallback();
    expect(fallback?.error).toContain("Invalid JSON");
    expect(config.llm.defaultModel).toBe("a");
    // Untouched: the owner may be mid-edit, and it is the only copy of their mistake.
    expect(await readFile(p, "utf-8")).toBe("{ this is not json");
  });

  test("the refused content is archived on the way through", async () => {
    const p = await target();
    await store.snapshot(p, { origin: "boot" });
    await store.confirm(p);
    await writeFile(p, "{ nope");
    await store.loadConfigOrFallback();
    const rejected = await readdir(join(dir, "backups", store.artifactId(p), "rejected"));
    expect(rejected).toHaveLength(1);
  });

  test("without a confirmed snapshot it throws and says the store was empty", async () => {
    await target("{ broken");
    await expect(store.loadConfigOrFallback()).rejects.toThrow(/Aucune sauvegarde confirmee/);
  });

  test("a valid config boots with no fallback marker", async () => {
    await target();
    const { fallback } = await store.loadConfigOrFallback();
    expect(fallback).toBeUndefined();
  });

  test("a structurally broken but JSON-valid config also falls back", async () => {
    const p = await target();
    await store.snapshot(p, { origin: "boot" });
    await store.confirm(p);
    // Valid JSON, unusable shape: this is the case that used to poison live state instead.
    await writeFile(p, JSON.stringify({ llm: "oops" }));
    const { config, fallback } = await store.loadConfigOrFallback();
    expect(fallback?.error).toContain("must be an object");
    expect(config.llm.defaultModel).toBe("a");
  });
});
