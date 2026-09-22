import { test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { rmSync, utimesSync, writeFileSync } from "node:fs";
import { MY_CLAW_DIR, loadEnv, resetEnvFileHotReload } from "../../src/core/config.ts";
import { CLI_RELEASE, claudeClaim, claudeRelease, claudeUserAgent } from "../../src/llm/anthropic-release.ts";

/**
 * The `.env` levers are hot: an edit applies at the next resolution, mid-run, on the next request
 * of the turn in flight. Not at the end of the run, not after a restart -- the owner's requirement
 * of 2026-09-22, and the one that matters the day Anthropic gates a new model on the claimed client
 * version: the fix has to reach the wire while a conversation is still open.
 *
 * The three claims are resolved per request (`claudeRelease`), and the file itself is re-applied the
 * moment its mtime moves (`refreshEnvFile`). What is asserted here is that whole path, not just the
 * `process.env` read: a value nobody re-reads is the bug this suite exists for.
 */

const ENV_PATH = join(MY_CLAW_DIR, ".env");

const KEYS = ["ANTHROPIC_CLI_VERSION", "ANTHROPIC_USER_AGENT", "ANTHROPIC_HIDE_THINKING"] as const;
const saved = new Map<string, string | undefined>();

let clock = 1_700_000_000;

function writeFileAt(text: string): void {
  writeFileSync(ENV_PATH, text);
  // mtime is the change signal, and a test writes twice inside one second: without moving it the
  // second write would look like no edit at all. Explicit beats a sleep that only usually works.
  clock += 5;
  utimesSync(ENV_PATH, clock, clock);
}

beforeEach(() => {
  resetEnvFileHotReload();
  for (const key of KEYS) saved.set(key, process.env[key]);
  for (const key of KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of KEYS) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(ENV_PATH, { force: true });
  resetEnvFileHotReload();
});

test("the claimed version follows an edit of .env on the next resolution, not the next restart", async () => {
  writeFileAt("ANTHROPIC_CLI_VERSION=2.1.280\n");
  await loadEnv();
  expect(claudeRelease().version).toBe("2.1.280");
  expect(claudeUserAgent()).toBe("claude-cli/2.1.280 (external, sdk-cli)");

  // The edit. Same process, same imports, a run could be mid-turn: only the next resolution sees
  // it, and the next resolution is the next request.
  writeFileAt("ANTHROPIC_CLI_VERSION=2.1.300\n");
  expect(claudeRelease().version).toBe("2.1.300");
  expect(claudeUserAgent()).toBe("claude-cli/2.1.300 (external, sdk-cli)");
});

test("an untouched file is not re-applied, and a process env change wins over it", async () => {
  writeFileAt("ANTHROPIC_CLI_VERSION=2.1.280\n");
  await loadEnv();
  expect(claudeRelease().version).toBe("2.1.280");

  // No write, so no re-apply: the process environment is free to move between resolutions and is
  // what the request uses. Only an edit of the file re-asserts the file.
  process.env["ANTHROPIC_CLI_VERSION"] = "9.9.9";
  expect(claudeRelease().version).toBe("9.9.9");

  writeFileAt("ANTHROPIC_CLI_VERSION=2.1.300\n");
  expect(claudeRelease().version).toBe("2.1.300");
});

test("a full user-agent override and a removed line keep their values", async () => {
  writeFileAt("ANTHROPIC_USER_AGENT=claude-cli/9.9.9 (external, sdk-cli)\n");
  await loadEnv();
  expect(claudeUserAgent()).toBe("claude-cli/9.9.9 (external, sdk-cli)");

  // The line is gone and the value stays: unsetting a credential or a claim on an edit is not
  // expressible here, and the next restart is where a deletion takes effect. Documented contract.
  writeFileAt("ANTHROPIC_CLI_VERSION=2.1.300\n");
  expect(claudeUserAgent()).toBe("claude-cli/9.9.9 (external, sdk-cli)");
  expect(claudeRelease().version).toBe("2.1.300");
});

test("with no lever set, the pinned capture is what a request claims", () => {
  const release = claudeRelease();
  expect(release.version).toBe(CLI_RELEASE.version);
  expect(release.stainlessPackage).toBe(CLI_RELEASE.stainlessPackage);
  expect(release.nodeVersion).toBe(CLI_RELEASE.nodeVersion);
  expect(claudeUserAgent()).toBe(`claude-cli/${CLI_RELEASE.version} (external, sdk-cli)`);
});

test("the claim names its source: the pinned capture, or the .env lever steering it", async () => {
  // The provider page draws this: `overridden` is the difference between "a line you wrote" and
  // "the captured client", and the version is always what goes on the wire.
  expect(claudeClaim()).toEqual({ version: CLI_RELEASE.version, pinned: CLI_RELEASE.version, overridden: false });

  writeFileAt("ANTHROPIC_CLI_VERSION=2.1.300\n");
  await loadEnv();
  expect(claudeClaim()).toEqual({ version: "2.1.300", pinned: CLI_RELEASE.version, overridden: true });
});
