/**
 * The compose install (docs/compose.md) as shipped: what the server derives for a compose install
 * must be what the compose file runs, and the two containers must look like one machine to the
 * paths they hand each other. Run for real on 2026-10-03 (browser driven from my-claw, Piper read
 * back by Whisper, SearXNG in JSON); these keep the wiring from drifting.
 */

import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { piperEndpoint, whisperEndpoint } from "../../src/services/catalog.ts";

const root = join(import.meta.dir, "..", "..");
const read = (path: string) => readFile(join(root, path), "utf8");

interface Service {
  profiles?: string[];
  volumes?: string[];
  build?: { dockerfile: string };
}

async function compose(): Promise<Record<string, Service>> {
  const doc = Bun.YAML.parse(await read("packaging/compose/compose.yml")) as { services: Record<string, Service> };
  return doc.services;
}

const COMPOSE = { MY_CLAW_INSTALL: "compose" };

describe("the compose file", () => {
  test("the server and its browser by default, every local engine behind a profile", async () => {
    const services = await compose();
    expect(services["my-claw"]!.profiles).toBeUndefined();
    expect(services["browser"]!.profiles).toBeUndefined();
    for (const engine of ["whisper", "piper", "searxng", "ntfy"]) expect(services[engine]!.profiles).toEqual([engine]);
  });

  test("the addresses the server derives are services of the file, on the ports their images expose", async () => {
    const services = await compose();
    const entrypoint = await read("packaging/compose/my-claw-entrypoint.sh");
    const sidecar = /\.browser\.sidecarUrl = "([^"]+)"/.exec(entrypoint)![1]!;
    for (const url of [whisperEndpoint({ stt: { mode: "local" } }, COMPOSE), piperEndpoint({}, COMPOSE)!, sidecar]) {
      const { hostname, port } = new URL(url);
      const service = services[hostname];
      expect(service).toBeDefined();
      const dockerfile = await read(service!.build!.dockerfile);
      expect(dockerfile).toMatch(new RegExp(`^EXPOSE .*\\b${port}\\b`, "m"));
    }
  });

  test("my-claw and the browser share home and /tmp at the same paths, and my-claw has no Docker socket", async () => {
    const services = await compose();
    const mounts = (name: string) => services[name]!.volumes ?? [];
    expect(mounts("my-claw")).toEqual(expect.arrayContaining(["home:/home/claw", "tmp:/tmp"]));
    expect(mounts("browser")).toEqual(expect.arrayContaining(["home:/home/claw", "tmp:/tmp"]));
    expect(JSON.stringify(services["my-claw"])).not.toContain("docker.sock");
  });

  test("the server image says it is a compose install, and both images run as the same user", async () => {
    const server = await read("packaging/compose/my-claw.Dockerfile");
    const browser = await read("packaging/compose/browser.Dockerfile");
    expect(server).toContain("MY_CLAW_INSTALL=compose");
    // uid 1000 in both: files one container writes into the shared home, the other must read.
    expect(server).toContain("usermod -l claw -d /home/claw -m bun");
    expect(browser).toContain("usermod -l claw -d /home/claw -m node");
  });

  test("the engines whose HTTP shape the server speaks are pinned", async () => {
    expect(await read("packaging/compose/piper.Dockerfile")).toContain('"piper-tts[http]==1.8.0"');
    expect(await read("packaging/compose/whisper.Dockerfile")).toContain("faster-whisper==1.2.1 av==17.0.0");
  });
});
