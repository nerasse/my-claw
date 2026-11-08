/**
 * A `bun test` started outside the repository root skips the bunfig.toml preload, and every test
 * then ran against the real ~/.my-claw: agent-model-command.test.ts overwrote and deleted the
 * production config.json, config-hot-reload.test.ts wiped its backups (2026-11-07). config.ts now
 * refuses to load under NODE_ENV=test unless both roots point elsewhere.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const configModule = join(import.meta.dir, "..", "..", "src", "core", "config.ts");

function load(env: Record<string, string | undefined>): { code: number; err: string } {
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...process.env, NODE_ENV: "test", ...env })) {
    if (v !== undefined) merged[k] = v;
  }
  const run = Bun.spawnSync([process.execPath, "-e", `import ${JSON.stringify(configModule)};`], {
    env: merged,
    cwd: tmpdir(),
  });
  return { code: run.exitCode, err: run.stderr.toString() };
}

describe("config.ts under bun test", () => {
  test("refuses to load when MY_CLAW_DIR is unset", () => {
    const { code, err } = load({ MY_CLAW_DIR: undefined });
    expect(code).not.toBe(0);
    expect(err).toContain("Refusing to run tests against the real");
  });

  test("refuses the real ~/.my-claw even when named explicitly", () => {
    const { code, err } = load({ MY_CLAW_DIR: join(homedir(), ".my-claw") });
    expect(code).not.toBe(0);
    expect(err).toContain("Refusing to run tests against the real");
  });

  test("refuses when only the backups are left on the real location", async () => {
    const dir = await mkdtemp(join(tmpdir(), "guard-"));
    const { code, err } = load({ MY_CLAW_DIR: dir, MY_CLAW_BACKUP_DIR: undefined });
    expect(code).not.toBe(0);
    expect(err).toContain("MY_CLAW_BACKUP_DIR");
  });

  test("loads when both roots are redirected, as the preload does", async () => {
    const dir = await mkdtemp(join(tmpdir(), "guard-"));
    const { code, err } = load({ MY_CLAW_DIR: dir, MY_CLAW_BACKUP_DIR: join(dir, "backups") });
    expect(err).toBe("");
    expect(code).toBe(0);
  });
});
