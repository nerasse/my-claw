import { describe, test, expect, afterEach } from "bun:test";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MY_CLAW_DIR } from "../../src/core/config.ts";
import { authHeaders, runWebCli } from "../../src/channels/my-claw-app/web-cli.ts";

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
