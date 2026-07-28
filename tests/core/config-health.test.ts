import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { MY_CLAW_DIR, CONFIG_PATH } from "../../src/core/config.ts";
import {
  snapshot,
  confirm,
  contentSha,
  readQuarantine,
  setQuarantine,
  clearQuarantine,
  clearStrikes,
  recordConfirmedSha,
  hasEverBeenConfirmed,
  bumpStrike,
  loadConfigOrFallback,
} from "../../src/core/config-store.ts";
import { isHealthy, decideAfterHealthGate, MAX_STRIKES } from "../../src/core/config-health.ts";

const storeRoot = join(MY_CLAW_DIR, "backups");
const GOOD = JSON.stringify({ llm: { defaultModel: "bon" }, channels: {} }, null, 2);
const BAD = JSON.stringify({ llm: { defaultModel: "mauvais" }, channels: {} }, null, 2);

beforeEach(async () => {
  await rm(storeRoot, { recursive: true, force: true });
  await rm(CONFIG_PATH, { force: true });
});

afterEach(async () => {
  await rm(storeRoot, { recursive: true, force: true });
  await rm(CONFIG_PATH, { force: true });
});

const decide = (over: Partial<Parameters<typeof decideAfterHealthGate>[0]> = {}) =>
  decideAfterHealthGate({
    healthy: false,
    currentSha: contentSha(BAD),
    confirmedSha: contentSha(GOOD),
    underServiceManager: true,
    ...over,
  });

describe("isHealthy", () => {
  test("a config with no channel enabled is healthy on uptime alone", () => {
    // Otherwise a deliberately channel-less setup would revert itself forever.
    expect(isHealthy({ expectsChannel: false, liveChannels: 0 })).toBe(true);
  });

  test("a config that enables a channel needs at least one up", () => {
    expect(isHealthy({ expectsChannel: true, liveChannels: 0 })).toBe(false);
    expect(isHealthy({ expectsChannel: true, liveChannels: 1 })).toBe(true);
  });
});

describe("decideAfterHealthGate", () => {
  test("healthy confirms", async () => {
    expect(await decide({ healthy: true })).toEqual({ action: "confirm" });
  });

  test("first failure retries, second quarantines", async () => {
    const first = await decide();
    expect(first.action).toBe("retry");
    expect((first as { strikes: number }).strikes).toBe(1);

    const second = await decide();
    expect(second.action).toBe("quarantine");
    expect((second as { strikes: number }).strikes).toBe(MAX_STRIKES);
  });

  test("strikes reset when the content changes", async () => {
    await decide();
    // The owner edited the file: this is a new attempt, not a repeat of the same failure.
    const other = await decide({ currentSha: "aaaaaaaaaaaa" });
    expect((other as { strikes: number }).strikes).toBe(1);
  });

  test("never reverts when there is nothing better to land on", async () => {
    expect((await decide({ confirmedSha: null })).action).toBe("warn");
    expect((await decide({ confirmedSha: contentSha(BAD) })).action).toBe("warn");
  });

  test("never reverts a config that already worked once", async () => {
    // Failing now, having been healthy before, points at the environment. Reverting would discard
    // the owner's later edits for a fault the config did not cause.
    await recordConfirmedSha(contentSha(BAD));
    const out = await decide();
    expect(out.action).toBe("warn");
    expect((out as { reason: string }).reason).toContain("environnement");
  });

  test("never restarts without a supervisor", async () => {
    const out = await decide({ underServiceManager: false });
    expect(out.action).toBe("warn");
    expect((out as { reason: string }).reason).toContain("superviseur");
  });

  test("no strike is recorded on the paths that only warn", async () => {
    await decide({ confirmedSha: null });
    await decide({ underServiceManager: false });
    // The first real failure must still be strike 1, not 3.
    expect((await decide()).action).toBe("retry");
  });
});

describe("confirmed-sha history", () => {
  test("records and recognises a content, and dedups", async () => {
    expect(await hasEverBeenConfirmed(contentSha(GOOD))).toBe(false);
    await recordConfirmedSha(contentSha(GOOD));
    await recordConfirmedSha(contentSha(GOOD));
    expect(await hasEverBeenConfirmed(contentSha(GOOD))).toBe(true);
    expect(await hasEverBeenConfirmed(contentSha(BAD))).toBe(false);
  });
});

describe("strikes", () => {
  test("count consecutively and reset on a different content", async () => {
    expect(await bumpStrike("aaa")).toBe(1);
    expect(await bumpStrike("aaa")).toBe(2);
    expect(await bumpStrike("bbb")).toBe(1);
    await clearStrikes();
    expect(await bumpStrike("bbb")).toBe(1);
  });
});

describe("quarantine at boot", () => {
  test("a quarantined config boots on the confirmed snapshot, file untouched", async () => {
    await writeFile(CONFIG_PATH, GOOD);
    await snapshot(CONFIG_PATH, { origin: "boot" });
    await confirm(CONFIG_PATH);

    await writeFile(CONFIG_PATH, BAD);
    await setQuarantine(contentSha(BAD), "aucun canal actif");

    const { config, fallback } = await loadConfigOrFallback();
    expect(config.llm.defaultModel).toBe("bon");
    expect(fallback?.error).toContain("quarantaine");
    // The quarantined content is valid JSON, so only the marker can stop it.
    expect(await Bun.file(CONFIG_PATH).text()).toBe(BAD);
  });

  test("editing the file lifts the quarantine by itself", async () => {
    await writeFile(CONFIG_PATH, GOOD);
    await snapshot(CONFIG_PATH, { origin: "boot" });
    await confirm(CONFIG_PATH);
    await writeFile(CONFIG_PATH, BAD);
    await setQuarantine(contentSha(BAD), "aucun canal actif");

    // Keyed on the content hash: any edit is a new attempt and needs no unquarantine command.
    const fixed = JSON.stringify({ llm: { defaultModel: "corrige" }, channels: {} }, null, 2);
    await writeFile(CONFIG_PATH, fixed);
    const { config, fallback } = await loadConfigOrFallback();
    expect(config.llm.defaultModel).toBe("corrige");
    expect(fallback).toBeUndefined();
  });

  test("a quarantine with nothing to fall back to is dropped rather than blocking boot", async () => {
    await writeFile(CONFIG_PATH, BAD);
    await setQuarantine(contentSha(BAD), "aucun canal actif");

    const { config, fallback } = await loadConfigOrFallback();
    expect(config.llm.defaultModel).toBe("mauvais");
    expect(fallback).toBeUndefined();
    expect(await readQuarantine()).toBeNull();
  });

  test("a quarantine on other content does not affect the current one", async () => {
    await writeFile(CONFIG_PATH, GOOD);
    await snapshot(CONFIG_PATH, { origin: "boot" });
    await confirm(CONFIG_PATH);
    await setQuarantine("ffffffffffff", "autre chose");

    const { fallback } = await loadConfigOrFallback();
    expect(fallback).toBeUndefined();
  });

  test("clearQuarantine removes the marker", async () => {
    await setQuarantine("abc", "x");
    expect(await readQuarantine()).not.toBeNull();
    await clearQuarantine();
    expect(await readQuarantine()).toBeNull();
  });
});
