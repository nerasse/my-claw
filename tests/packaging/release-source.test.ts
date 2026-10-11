/**
 * packaging/release-source.sh, sourced as shipped and run against dl-hub's layout on loopback.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const helper = join(import.meta.dir, "..", "..", "packaging", "release-source.sh");
const KEY = "dlh_shell-key";
const seen: Array<{ path: string; auth: string | null }> = [];

const fake = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const url = new URL(req.url);
    const auth = req.headers.get("authorization");
    seen.push({ path: url.pathname, auth });
    if (url.pathname.startsWith("/apkonly/")) {
      return Response.json({ version: "0.6.144", files: [{ name: "my-claw-app-v0.6.144.apk" }] });
    }
    if (url.pathname === "/odd/server/latest.json") return Response.json({ version: "0.8.0-rc1" });
    if (auth !== `Bearer ${KEY}`) return new Response("a download key is needed", { status: 401 });
    if (url.pathname === "/hub/server/latest.json") return Response.json({ version: "0.7.102", files: [] });
    if (url.pathname === "/hub/app/latest.json") {
      return Response.json({ version: "0.6.143", files: [{ name: "my-claw-app-v0.6.143.apk" }, { name: "dist-web.tar.gz" }] });
    }
    return new Response(null, { status: 404 });
  },
});
const BASE = `http://127.0.0.1:${fake.port}`;
afterAll(() => fake.stop(true));

/** Runs a snippet after sourcing the helper. Async: the fake source answers from this process. */
async function sh(script: string, env: Record<string, string> = {}): Promise<string> {
  const run = Bun.spawn(["bash", "-c", `set -euo pipefail\n. "${helper}"\n${script}`], {
    env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited]);
  if (code !== 0) throw new Error(`exit ${code}: ${err}`);
  return out.trim();
}

const HUB = { MY_CLAW_RELEASE_URL: `${BASE}/hub`, MY_CLAW_RELEASE_KEY: KEY };

describe("from dl-hub", () => {
  test("the latest server, its tarball URL and the latest web bundle, read with the key", async () => {
    seen.length = 0;
    expect(await sh("release_describe; release_latest_server; release_server_url 0.7.102; release_latest_web", HUB)).toBe(
      [`${BASE}/hub`, "0.7.102", `${BASE}/hub/server/0.7.102/my-claw-0.7.102-linux-x64.tar.gz`, "v0.6.143"].join("\n"),
    );
    expect(seen.map((s) => s.auth)).toEqual([`Bearer ${KEY}`, `Bearer ${KEY}`]);
  });

  test("a latest app release without a web bundle leaves nothing to install", async () => {
    expect(await sh("release_latest_web", { MY_CLAW_RELEASE_URL: `${BASE}/apkonly` })).toBe("");
  });

  test("a version that is not three numbers is no version", async () => {
    expect(await sh("release_latest_server", { MY_CLAW_RELEASE_URL: `${BASE}/odd` })).toBe("");
  });

  test("a refused key reads as no version, not as an error that kills the caller", async () => {
    expect(await sh("v=$(release_latest_server); echo \"[$v]\"", { ...HUB, MY_CLAW_RELEASE_KEY: "dlh_wrong" })).toBe("[]");
  });

  test("the key never reaches curl's command line; no key, no header", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fake-curl-"));
    const shim = join(dir, "curl");
    await writeFile(shim, `#!/bin/bash\necho "$@" > "${dir}/argv"\ncat > "${dir}/stdin" 2>/dev/null || true\n`);
    await chmod(shim, 0o755);
    const path = `${dir}:${process.env["PATH"]}`;
    await sh("release_curl -fsS https://example.test/x", { ...HUB, PATH: path });
    expect(await readFile(join(dir, "argv"), "utf8")).not.toContain(KEY);
    expect(await readFile(join(dir, "stdin"), "utf8")).toBe(`header = "Authorization: Bearer ${KEY}"\n`);
    await sh("release_curl -fsS https://example.test/y < /dev/null", { MY_CLAW_RELEASE_URL: `${BASE}/hub`, PATH: path });
    expect(await readFile(join(dir, "argv"), "utf8")).toBe("-fsS https://example.test/y\n");
  });
});

describe("no source", () => {
  test("a forge token alone is no source, and nothing is asked anywhere", async () => {
    seen.length = 0;
    const env = { FORGEJO_URL: BASE, FORGEJO_TOKEN: "forge-token" };
    expect(await sh("release_configured || echo none; release_describe; v=$(release_latest_server); echo \"[$v]\"", env)).toBe("none\nnone\n[]");
    expect(seen).toEqual([]);
  });
});

describe("the .env", () => {
  test("is read with quotes and trailing slashes dropped; a missing file is no source", async () => {
    const dir = await mkdtemp(join(tmpdir(), "release-env-"));
    const env = join(dir, ".env");
    await writeFile(env, `# comment\nMY_CLAW_RELEASE_URL="https://dl.example.test/my-claw/"\nMY_CLAW_RELEASE_KEY='dlh_q'\nOTHER=x\n`);
    expect(await sh(`read_release_env "${env}"; echo "$MY_CLAW_RELEASE_URL|$MY_CLAW_RELEASE_KEY"; release_describe`)).toBe(
      "https://dl.example.test/my-claw|dlh_q\nhttps://dl.example.test/my-claw",
    );
    expect(await sh(`read_release_env "${dir}/missing"; release_configured || echo none`)).toBe("none");
  });

  test("a template placeholder is no value", async () => {
    const dir = await mkdtemp(join(tmpdir(), "release-env-"));
    const env = join(dir, ".env");
    await writeFile(env, "MY_CLAW_RELEASE_URL=https://dl.example.test/my-claw\nMY_CLAW_RELEASE_KEY=your_release_key_here\n");
    expect(await sh(`read_release_env "${env}"; echo "[$MY_CLAW_RELEASE_KEY]"`)).toBe("[]");
  });
});
