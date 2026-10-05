import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENTRY = join(import.meta.dir, "..", "..", "src", "index.ts");
const TOKEN = `sk-ant-oat01-${"c".repeat(40)}`;

function claudeCli(dir: string, ...args: string[]): { code: number; out: string } {
  const run = Bun.spawnSync([process.execPath, ENTRY, "claude", ...args], { env: { ...process.env, MY_CLAW_DIR: dir } });
  return { code: run.exitCode, out: run.stdout.toString() + run.stderr.toString() };
}

const providersOf = (dir: string) => (JSON.parse(readFileSync(join(dir, "config.json"), "utf-8")) as { llm?: { providers?: Record<string, unknown> } }).llm?.providers;

test("a CLI sign-in with no Claude plan declared declares one, so its models can be offered", () => {
  const dir = mkdtempSync(join(tmpdir(), "account-cli-"));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ llm: { providers: { claude: { baseUrl: "https://x", apiKeyEnv: "K" } } } }));
  const run = claudeCli(dir, "set-token", TOKEN);
  assert.equal(run.code, 0, run.out);
  // `claude` is taken by a provider that is not a plan: the plan is numbered, never clobbers it.
  assert.deepEqual(providersOf(dir)?.["claude2"], { type: "anthropic", group: "Claude", discover: true });
  assert.deepEqual(providersOf(dir)?.["claude"], { baseUrl: "https://x", apiKeyEnv: "K" });
  assert.equal(statSync(join(dir, "accounts", "claude2.json")).mode & 0o777, 0o600);
});

test("a CLI sign-in on a declared plan leaves the config as it was", () => {
  const dir = mkdtempSync(join(tmpdir(), "account-cli-"));
  const config = JSON.stringify({ llm: { providers: { perso: { type: "anthropic", group: "Perso" } } } });
  writeFileSync(join(dir, "config.json"), config);
  const run = claudeCli(dir, "set-token", TOKEN);
  assert.equal(run.code, 0, run.out);
  assert.equal(readFileSync(join(dir, "config.json"), "utf-8"), config);
  assert.ok(existsSync(join(dir, "accounts", "perso.json")));
});

test("a CLI sign-in on a key of the owner's choosing declares it under that name", () => {
  const dir = mkdtempSync(join(tmpdir(), "account-cli-"));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ llm: { providers: { claude: { type: "anthropic", group: "Claude" } } } }));
  const run = claudeCli(dir, "set-token", "--provider", "work", TOKEN);
  assert.equal(run.code, 0, run.out);
  assert.deepEqual(providersOf(dir)?.["work"], { type: "anthropic", group: "work", discover: true });
  assert.ok(existsSync(join(dir, "accounts", "work.json")));
});
