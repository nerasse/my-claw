/**
 * `myclaw setup`: the first device of a fresh install, printed by the installer as a code, a link
 * and a QR (docs/setup-guide.md). Run for real on Debian 12 and Ubuntu 24.04 by tests-install/.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { CONFIG_PATH } from "../../src/core/config.ts";
import { FIRST_DEVICE, publicBase, runSetupCli } from "../../src/channels/my-claw-app/device-cli.ts";
import { mockFetch } from "../helpers/mock-fetch.ts";

type Devices = Record<string, { token: string; name?: string; lastSeenAt?: string }>;

async function writeDevices(devices: Devices): Promise<void> {
  await mkdir(dirname(CONFIG_PATH), { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify({ channels: { "my-claw-app": { port: 8080, pairing: { enabled: true }, devices } } }));
}

async function devices(): Promise<Devices> {
  return JSON.parse(await readFile(CONFIG_PATH, "utf-8")).channels["my-claw-app"].devices;
}

let lines: string[] = [];
let tickets: string[] = [];
let restoreFetch: () => void = () => {};
const realLog = console.log;

beforeEach(() => {
  lines = [];
  tickets = [];
  console.log = (...args: unknown[]) => void lines.push(args.join(" "));
  restoreFetch = mockFetch(async (input) => {
    tickets.push(String(input));
    return Response.json({ code: "ABCD2345", host: "127.0.0.1:8080" });
  }).restore;
});
afterEach(async () => {
  console.log = realLog;
  restoreFetch();
  await rm(CONFIG_PATH, { force: true });
});

describe("myclaw setup", () => {
  test("a fresh install: one device minted, its code printed at the address the devices dial", async () => {
    await writeDevices({});
    expect(await runSetupCli(["--url", "http://10.0.0.7:8080/"], {})).toBe(0);
    const minted = Object.entries(await devices());
    expect(minted).toHaveLength(1);
    expect(minted[0]![1].name).toBe(FIRST_DEVICE);
    expect(tickets).toHaveLength(1);
    expect(lines).toContain("Code    ABCD-2345   (single use, ten minutes)");
    expect(lines).toContain("Web     http://10.0.0.7:8080/pair#ABCD2345");
    expect(lines).toContain("App     server ws://10.0.0.7:8080/my-claw-app, then type the code");
  });

  test("a rerun before anything connected asks for a new code for the same device", async () => {
    await writeDevices({});
    await runSetupCli([], {});
    const first = Object.keys(await devices());
    await runSetupCli([], {});
    expect(Object.keys(await devices())).toEqual(first);
    expect(tickets).toHaveLength(2);
  });

  test("once a device has connected, setup mints nothing and asks for no code", async () => {
    await writeDevices({ "app-11111111": { token: "t", name: "Phone", lastSeenAt: "2026-10-03T10:00:00.000Z" } });
    expect(await runSetupCli([], {})).toBe(0);
    expect(Object.keys(await devices())).toEqual(["app-11111111"]);
    expect(tickets).toEqual([]);
    expect(lines[0]).toContain("Already paired");
    // Where the next one comes from, as the app says it today: no shell needed.
    expect(lines[1]).toContain("Settings > Devices > Add a device");
  });
});

test("the public address: --url, else MYCLAW_PUBLIC_URL, else what the daemon was asked on", () => {
  expect(publicBase("https://claw.example.com/", { MYCLAW_PUBLIC_URL: "http://x:1" }, "127.0.0.1:8080")).toBe("https://claw.example.com");
  expect(publicBase(undefined, { MYCLAW_PUBLIC_URL: "http://localhost:18080" }, "127.0.0.1:8080")).toBe("http://localhost:18080");
  expect(publicBase(undefined, {}, "127.0.0.1:8080")).toBe("http://127.0.0.1:8080");
});
