/**
 * The client's self-update: fetch the build the server runs, prove it works, replace itself,
 * restart. The failures are the interesting half -- a relay that refuses or a truncated binary
 * must leave the old one serving.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyUpdate, canAttemptUpdate, markUpdateAttempt, resetUpdateGuard } from "../../src/node-client/update.ts";

const VERSION = "0.7.114";

let dir: string;

beforeEach(async () => {
  resetUpdateGuard();
  dir = await mkdtemp(join(tmpdir(), "node-update-test-"));
});

/** The staged binary the mock relay serves: a script that prints what it is. */
function binaryPrinting(version: string): string {
  return `#!/bin/sh\necho ${version}\n`;
}

async function fakeExec(version = "0.7.113"): Promise<string> {
  const path = join(dir, "myclaw-node-test");
  await writeFile(path, binaryPrinting(version));
  await chmod(path, 0o755);
  return path;
}

const silent = { log: () => undefined };

describe("node self-update", () => {
  test("a good build replaces the running binary and restarts", async () => {
    const execPath = await fakeExec();
    let restarted = 0;
    const outcome = await applyUpdate({
      server: "wss://myclaw.example/node",
      token: "tok",
      version: VERSION,
      target: "linux-x64",
      execPath,
      fetchImpl: async (input) => {
        expect(String(input)).toBe(`https://myclaw.example/node/download?target=linux-x64&version=${VERSION}`);
        return new Response(binaryPrinting(VERSION), { status: 200 });
      },
      restart: () => {
        restarted += 1;
      },
      ...silent,
    });
    expect(outcome).toBe("updated");
    expect(restarted).toBe(1);
    expect(await readFile(execPath, "utf-8")).toBe(binaryPrinting(VERSION));
    // The staging file is gone: it became the binary.
    await expect(readFile(`${execPath}.new`, "utf-8")).rejects.toBeDefined();
  });

  test("a refused download changes nothing", async () => {
    const execPath = await fakeExec();
    let restarted = 0;
    const outcome = await applyUpdate({
      server: "wss://myclaw.example/node",
      token: "tok",
      version: VERSION,
      target: "linux-x64",
      execPath,
      fetchImpl: async () => new Response("no build", { status: 404 }),
      restart: () => {
        restarted += 1;
      },
      ...silent,
    });
    expect(outcome).toBe("failed");
    expect(restarted).toBe(0);
    expect(await readFile(execPath, "utf-8")).toBe(binaryPrinting("0.7.113"));
  });

  test("a binary that does not prove its version is thrown away", async () => {
    const execPath = await fakeExec();
    let restarted = 0;
    const outcome = await applyUpdate({
      server: "wss://myclaw.example/node",
      token: "tok",
      version: VERSION,
      target: "linux-x64",
      execPath,
      fetchImpl: async () => new Response(binaryPrinting("9.9.9"), { status: 200 }),
      restart: () => {
        restarted += 1;
      },
      ...silent,
    });
    expect(outcome).toBe("failed");
    expect(restarted).toBe(0);
    expect(await readFile(execPath, "utf-8")).toBe(binaryPrinting("0.7.113"));
    await expect(readFile(`${execPath}.new`, "utf-8")).rejects.toBeDefined();
  });

  test("a dev run never replaces its runtime", async () => {
    let fetched = 0;
    const outcome = await applyUpdate({
      server: "wss://myclaw.example/node",
      token: "tok",
      version: VERSION,
      target: "linux-x64",
      execPath: join(dir, "bun"),
      fetchImpl: async () => {
        fetched += 1;
        return new Response(binaryPrinting(VERSION), { status: 200 });
      },
      ...silent,
    });
    expect(outcome).toBe("failed");
    expect(fetched).toBe(0);
  });

  test("one attempt per version per window", () => {
    const base = 10_000_000_000;
    expect(canAttemptUpdate(VERSION, base)).toBe(true);
    markUpdateAttempt(VERSION, base);
    expect(canAttemptUpdate(VERSION, base + 60_000)).toBe(false);
    expect(canAttemptUpdate(VERSION, base + 31 * 60_000)).toBe(true);
    expect(canAttemptUpdate("0.7.115", base)).toBe(true);
  });
});
