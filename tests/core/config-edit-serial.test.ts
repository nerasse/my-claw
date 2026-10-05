import { test, expect, afterEach } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { CONFIG_PATH } from "../../src/core/config.ts";
import { oneEditAtATime, setService, setUiPrefs, upsertDevice } from "../../src/core/config-edit.ts";

/**
 * Every edit reads config.json, changes it and writes it back. Two at once used to lose one: a
 * device's last-seen stamp, written on its first frame, overwrote the service that frame had just
 * set (compose test, 2026-10-05).
 */

afterEach(async () => {
  await rm(CONFIG_PATH, { force: true });
});

async function seed(data: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(CONFIG_PATH), { recursive: true });
  await writeFile(CONFIG_PATH, `${JSON.stringify(data, null, 2)}\n`);
}

test("edits asked at the same time all land", async () => {
  await seed({ channels: { "my-claw-app": { devices: { d1: { token: "t" } } } }, memory: { enabled: true } });
  const results = await Promise.all([
    setService({ id: "embeddings", source: "self-hosted" }),
    upsertDevice("d1", { token: "t", lastSeenAt: "2026-10-05T22:00:00.000Z" }),
    setUiPrefs({ expandReasoning: true }),
  ]);
  expect(results.every((r) => r.ok)).toBe(true);
  const written = JSON.parse(await readFile(CONFIG_PATH, "utf-8"));
  expect(written.memory.embedding).toMatchObject({ backend: "local" });
  expect(written.channels["my-claw-app"].devices.d1.lastSeenAt).toBe("2026-10-05T22:00:00.000Z");
  expect(JSON.stringify(written)).toContain("expandReasoning");
});

test("one that fails does not stop the ones after it", async () => {
  const order: string[] = [];
  const failed = oneEditAtATime(async () => {
    order.push("first");
    throw new Error("broken");
  });
  const second = oneEditAtATime(async () => {
    order.push("second");
    return "ok";
  });
  await expect(failed).rejects.toThrow("broken");
  expect(await second).toBe("ok");
  expect(order).toEqual(["first", "second"]);
});
