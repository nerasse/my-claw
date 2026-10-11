import { describe, test, expect, afterEach } from "bun:test";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MY_CLAW_DIR } from "../../src/core/config.ts";
import { runWebCli } from "../../src/channels/my-claw-app/web-cli.ts";
import { appFileUrl, authHeaders } from "../../src/channels/my-claw-app/release-source.ts";
import { mockFetch } from "../helpers/mock-fetch.ts";

/**
 * `myclaw web install` never worked on a real machine, and both reasons were invisible from the
 * code alone: the release repository is private (an anonymous GET of a private asset is a 404,
 * not a 401) and the staging directory sat in /tmp, which is a different filesystem, so the final
 * rename failed with EXDEV after the download and the extraction had both succeeded.
 */

const WEB_DIR = join(MY_CLAW_DIR, "web");

afterEach(async () => {
  await rm(WEB_DIR, { recursive: true, force: true });
  delete process.env["FORGEJO_TOKEN"];
  delete process.env["FORGEJO_URL"];
  delete process.env["MY_CLAW_RELEASE_URL"];
  delete process.env["MY_CLAW_RELEASE_KEY"];
});

describe("release credentials", () => {
  test("the token travels to the forge and nowhere else", () => {
    process.env["FORGEJO_TOKEN"] = "secret";
    process.env["FORGEJO_URL"] = "https://git.example.test";

    expect(authHeaders("https://git.example.test/claw/my-claw-app/releases/download/v1/x.tar.gz")).toEqual({
      Authorization: "token secret",
    });
    // A --from pointing at a mirror is a plain download: a credential handed to whatever host was
    // typed on the command line is how the forge token ends up in someone else's logs.
    expect(authHeaders("https://mirror.example.test/x.tar.gz")).toEqual({});
    // Same host over plain HTTP is a downgrade, and the token is not sent over it either.
    expect(authHeaders("http://git.example.test/x.tar.gz")).toEqual({});
  });

  test("no token configured means no header, not a broken one", () => {
    process.env["FORGEJO_URL"] = "https://git.example.test";
    expect(authHeaders("https://git.example.test/x.tar.gz")).toEqual({});
  });

  test("a source that is not a URL is never given a header", () => {
    process.env["FORGEJO_TOKEN"] = "secret";
    expect(authHeaders("/home/me/dist-web.tar.gz")).toEqual({});
  });

  test("a release key travels to the hub as a bearer, and wins over the forge token", () => {
    process.env["FORGEJO_TOKEN"] = "forge-secret";
    process.env["FORGEJO_URL"] = "https://git.example.test";
    process.env["MY_CLAW_RELEASE_URL"] = "https://dl.example.test/my-claw";
    process.env["MY_CLAW_RELEASE_KEY"] = "dlh_k";
    expect(authHeaders("https://dl.example.test/my-claw/app/1.2.3/dist-web.tar.gz")).toEqual({ Authorization: "Bearer dlh_k" });
    expect(authHeaders("https://git.example.test/claw/my-claw-app/releases/download/v1/x.tar.gz")).toEqual({});
    expect(authHeaders("http://dl.example.test/my-claw/x")).toEqual({});
  });

  test("a public source without a key gets no header", () => {
    process.env["MY_CLAW_RELEASE_URL"] = "https://dl.example.test/my-claw";
    expect(authHeaders("https://dl.example.test/my-claw/app/1.2.3/dist-web.tar.gz")).toEqual({});
  });
});

describe("the default source", () => {
  test("is the web bundle of that version on the release source, tag or bare version", () => {
    process.env["MY_CLAW_RELEASE_URL"] = "https://dl.example.test/my-claw/";
    expect(appFileUrl("v0.6.143", "web")).toBe("https://dl.example.test/my-claw/app/0.6.143/dist-web.tar.gz");
    expect(appFileUrl("0.6.143", "web")).toBe("https://dl.example.test/my-claw/app/0.6.143/dist-web.tar.gz");
    delete process.env["MY_CLAW_RELEASE_URL"];
    process.env["FORGEJO_URL"] = "https://git.example.test";
    process.env["FORGEJO_TOKEN"] = "t";
    expect(appFileUrl("v0.6.143", "web")).toBe("https://git.example.test/claw/my-claw-app/releases/download/v0.6.143/dist-web.tar.gz");
  });

  test("with no source, install without --from says what to do and downloads nothing", async () => {
    const seen: string[] = [];
    const fetchMock = mockFetch(async (input) => {
      seen.push(String(input));
      return new Response("", { status: 500 });
    });
    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => errors.push(args.join(" "));
    try {
      expect(await runWebCli(["install", "v0.6.143"])).toBe(1);
    } finally {
      console.error = original;
      fetchMock.restore();
    }
    expect(seen).toEqual([]);
    expect(errors.join("\n")).toContain("myclaw release-key");
  });
});

describe("install", () => {
  async function tarball(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "web-fixture-"));
    await mkdir(join(dir, "dist-web"), { recursive: true });
    await writeFile(join(dir, "dist-web", "index.html"), "<!DOCTYPE html>");
    await writeFile(join(dir, "dist-web", "index.js"), "console.log(1)");
    const tar = Bun.spawn(["tar", "-czf", join(dir, "dist-web.tar.gz"), "-C", dir, "dist-web"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await tar.exited).toBe(0);
    return join(dir, "dist-web.tar.gz");
  }

  test("a local bundle is extracted, made current, and listed", async () => {
    expect(await runWebCli(["install", "v9.9.9", "--from", await tarball()])).toBe(0);

    const installed = await readdir(WEB_DIR);
    expect(installed).toContain("v9.9.9");
    expect(installed).toContain("current");
    expect(await Bun.file(join(WEB_DIR, "current", "index.html")).text()).toContain("DOCTYPE");
  });

  test("staging leaves nothing behind, and a leftover would not read as a version", async () => {
    expect(await runWebCli(["install", "v9.9.9", "--from", await tarball()])).toBe(0);
    // The staging directory lives here, next to the target, because a rename cannot cross a
    // filesystem. It is hidden, so a crash leaves clutter rather than a phantom version.
    const entries = await readdir(WEB_DIR);
    expect(entries.filter((name) => name.startsWith(".staging-"))).toEqual([]);

    await mkdir(join(WEB_DIR, ".staging-crashed"), { recursive: true });
    expect(await runWebCli(["ls"])).toBe(0);
    const after = await readdir(WEB_DIR);
    expect(after).toContain(".staging-crashed");
  });

  test("an archive with no client in it is refused", async () => {
    const dir = await mkdtemp(join(tmpdir(), "web-empty-"));
    await writeFile(join(dir, "note.txt"), "nothing here");
    const tar = Bun.spawn(["tar", "-czf", join(dir, "empty.tar.gz"), "-C", dir, "note.txt"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await tar.exited).toBe(0);

    expect(await runWebCli(["install", "v0.0.0", "--from", join(dir, "empty.tar.gz")])).toBe(1);
    expect(await readdir(WEB_DIR).catch(() => [])).not.toContain("v0.0.0");
  });
});
