import { test, expect, afterEach } from "bun:test";
import { readdir, readFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { MY_CLAW_DIR } from "../../src/core/config.ts";
import { log, setLogLevelSource, getLogLevel } from "../../src/utils/logger.ts";
import { withRunContext } from "../../src/utils/run-context.ts";

const LOGS_DIR = join(MY_CLAW_DIR, "logs");

async function readOrchestratorLog(): Promise<string> {
  const files = (await readdir(LOGS_DIR)).filter((f) => f.startsWith("orchestrator-"));
  const parts = await Promise.all(files.map((f) => readFile(join(LOGS_DIR, f), "utf8")));
  return parts.join("");
}

async function freshLogs(): Promise<void> {
  await rm(LOGS_DIR, { recursive: true, force: true });
  await mkdir(LOGS_DIR, { recursive: true });
}

afterEach(() => {
  // Module-level state: leaving a level behind would silence every later test file.
  setLogLevelSource(() => undefined);
});

test("every line of a run carries the same correlation id", async () => {
  await freshLogs();

  await withRunContext({ platform: "mobile" }, async () => {
    await log("info", "step one");
    await log("info", "step two");
  });
  await log("info", "outside any run");

  const lines = (await readOrchestratorLog()).trim().split("\n").map((l) => JSON.parse(l) as { message: string; run?: string });
  const inRun = lines.filter((l) => l.message.startsWith("step"));
  expect(inRun.length).toBe(2);
  expect(inRun[0]!.run).toMatch(/^[0-9a-f]{8}$/);
  expect(inRun[1]!.run).toBe(inRun[0]!.run);
  expect(lines.find((l) => l.message === "outside any run")?.run).toBeUndefined();
});

test("the configured level is a floor, read live so a hot reload applies at once", async () => {
  await freshLogs();
  let level: "debug" | "warn" = "warn";
  setLogLevelSource(() => level);
  expect(getLogLevel()).toBe("warn");

  await log("info", "dropped by the floor");
  await log("error", "kept");

  level = "debug";
  await log("info", "kept after the reload");

  const content = await readOrchestratorLog();
  expect(content).not.toContain("dropped by the floor");
  expect(content).toContain("kept");
  expect(content).toContain("kept after the reload");
});
