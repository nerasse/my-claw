import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  exposedTools,
  httpBaseOf,
  loadClientTls,
  loadConfig,
  loadToken,
  nodeDir,
  pathAllowed,
  saveClientTls,
  saveConfig,
  saveToken,
  type NodeClientConfig,
} from "../../src/node-client/config.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "node-client-test-"));
});

const base: NodeClientConfig = { server: "wss://myclaw.example/node" };

describe("node client config", () => {
  test("all tools by default; readOnly drops the writes, unknown names are filtered", () => {
    expect(exposedTools(base)).toEqual(["bash", "read", "write", "apply_patch", "search", "ls"]);
    expect(exposedTools({ ...base, readOnly: true })).toEqual(["bash", "read", "search", "ls"]);
    expect(exposedTools({ ...base, tools: ["bash", "nope"] as never })).toEqual(["bash"]);
  });

  test("roots fence the file tools, prefixes included", () => {
    expect(pathAllowed(base, "/etc/passwd")).toBe(true);
    const fenced = { ...base, roots: ["/srv/data"] };
    expect(pathAllowed(fenced, "/srv/data")).toBe(true);
    expect(pathAllowed(fenced, "/srv/data/sub/file")).toBe(true);
    // The prefix trap: /srv/data2 is not inside /srv/data.
    expect(pathAllowed(fenced, "/srv/data2/file")).toBe(false);
    expect(pathAllowed(fenced, "/etc/passwd")).toBe(false);
  });

  test("the config dir follows MYCLAW_NODE_DIR", () => {
    expect(nodeDir({ MYCLAW_NODE_DIR: "/tmp/custom" })).toBe("/tmp/custom");
    expect(nodeDir({})).toContain(".my-claw-node");
  });

  test("the http base is the ws url with the other scheme", () => {
    expect(httpBaseOf("wss://myclaw.example/node")).toBe("https://myclaw.example/node");
    expect(httpBaseOf("ws://127.0.0.1:8080/node")).toBe("http://127.0.0.1:8080/node");
    expect(httpBaseOf("wss://myclaw.example/node/")).toBe("https://myclaw.example/node");
  });

  test("config and token round-trip; the token is 0600", async () => {
    await saveConfig({ ...base, name: "web01" }, dir);
    const loaded = await loadConfig(dir);
    expect(loaded?.server).toBe("wss://myclaw.example/node");
    expect(loaded?.name).toBe("web01");

    await saveToken("s3cret", dir);
    expect(await loadToken(dir)).toBe("s3cret");
    if (process.platform !== "win32") {
      const mode = (await stat(join(dir, "token"))).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  test("a config without a server is refused, a missing one reads as null", async () => {
    expect(await loadConfig(dir)).toBeNull();
    await writeFile(join(dir, "config.json"), JSON.stringify({ name: "x" }));
    expect(await loadConfig(dir)).toBeNull();
  });

  test("the certificate bundle round-trips, and is absent when never written", async () => {
    expect(await loadClientTls(dir)).toBeNull();
    await saveClientTls({ ca: "CA", cert: "CERT", key: "KEY" }, dir);
    expect(await loadClientTls(dir)).toEqual({ ca: "CA", cert: "CERT", key: "KEY" });
    if (process.platform !== "win32") {
      const mode = (await stat(join(dir, "client-key.pem"))).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });
});
