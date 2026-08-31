import { lstat, mkdtemp, mkdir, readdir, readlink, rename, rm, stat, symlink, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { MY_CLAW_DIR } from "../../core/config.ts";
import { authHeaders, forgeBase } from "./forge.ts";

/**
 * `myclaw web`: installs the web client bundle the channel serves.
 *
 * The app and the server release independently, so the bundle is an artifact the server pulls
 * rather than something it carries. Versions live side by side and `current` is a symlink, which
 * makes a rollback a rename and never a re-download.
 *
 * Forgejo credentials live in ./forge.ts: the token travels to the configured forge and nowhere
 * else (a private release asset answers an anonymous GET with a 404, not a 401).
 */

const USAGE = `usage: myclaw web <command>

  install <version> [--from <url|path>]   install a bundle and make it current
  ls                                      installed versions, and which one is current
  use <version>                           point current at an installed version
  rm <version>                            delete an installed version
`;

const WEB_DIR = (): string => join(MY_CLAW_DIR, "web");
const CURRENT = (): string => join(WEB_DIR(), "current");

const DEFAULT_SOURCE = (version: string): string =>
  `${forgeBase()}/claw/my-claw-app/releases/download/${version}/dist-web.tar.gz`;

export { authHeaders } from "./forge.ts";

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function currentVersion(): Promise<string | undefined> {
  try {
    const resolved = await stat(CURRENT());
    if (!resolved.isDirectory()) return undefined;
  } catch {
    return undefined;
  }
  try {
    return (await readlink(CURRENT())).split("/").filter(Boolean).pop();
  } catch {
    return undefined;
  }
}

async function listVersions(): Promise<string[]> {
  try {
    const entries = await readdir(WEB_DIR(), { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && entry.name !== "current" && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Extraction goes to a staging directory and is renamed into place: a half-extracted tree is
 * never served, because the serving path only ever sees the finished one.
 *
 * The staging directory sits inside the web directory, not in `/tmp`. A rename only works within
 * one filesystem, and `/tmp` is a tmpfs on any normal machine: staging there made the last step
 * fail with EXDEV every single time, after the download and the extraction had both succeeded.
 * The name starts with a dot so a leftover from a crash is never listed as a version.
 */
async function installFrom(source: string, version: string): Promise<{ ok: true } | { ok: false; error: string }> {
  await mkdir(WEB_DIR(), { recursive: true });
  const staging = await mkdtemp(join(WEB_DIR(), ".staging-"));
  const archive = join(staging, "dist-web.tar.gz");

  try {
    if (source.startsWith("http://") || source.startsWith("https://")) {
      const headers = authHeaders(source);
      const response = await fetch(source, { headers });
      if (!response.ok) {
        const hint =
          response.status === 404 && Object.keys(headers).length === 0
            ? " (a private release reads as 404 when anonymous: set FORGEJO_TOKEN in ~/.my-claw/.env)"
            : "";
        return { ok: false, error: `download failed: HTTP ${response.status}${hint}` };
      }
      await Bun.write(archive, response);
    } else {
      if (!(await exists(source))) return { ok: false, error: `no such file: ${source}` };
      await Bun.write(archive, Bun.file(source));
    }

    const bytes = await Bun.file(archive).arrayBuffer();
    const digest = createHash("sha256").update(new Uint8Array(bytes)).digest("hex");

    const extracted = join(staging, "root");
    await mkdir(extracted, { recursive: true });
    const tar = Bun.spawn(["tar", "-xzf", archive, "-C", extracted], { stdout: "pipe", stderr: "pipe" });
    if ((await tar.exited) !== 0) {
      return { ok: false, error: `tar failed: ${await new Response(tar.stderr).text()}` };
    }

    // A tarball may or may not carry a top directory; the bundle is wherever index.html is.
    const root = (await exists(join(extracted, "index.html")))
      ? extracted
      : await (async () => {
          const entries = await readdir(extracted, { withFileTypes: true });
          const dir = entries.find((entry) => entry.isDirectory());
          return dir ? join(extracted, dir.name) : extracted;
        })();
    if (!(await exists(join(root, "index.html")))) {
      return { ok: false, error: "the archive has no index.html" };
    }

    const target = join(WEB_DIR(), version);
    await rm(target, { recursive: true, force: true });
    await rename(root, target);

    console.log(`Installed ${version} (sha256 ${digest.slice(0, 16)})`);
    return { ok: true };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function pointCurrentAt(version: string): Promise<{ ok: boolean; error?: string }> {
  const target = join(WEB_DIR(), version);
  if (!(await exists(target))) return { ok: false, error: `${version} is not installed` };

  // A real directory at `current` is somebody's hand-installed bundle. Replacing it would delete
  // files nobody asked to lose, so it is reported instead of removed.
  const existing = await lstat(CURRENT()).catch(() => undefined);
  if (existing && !existing.isSymbolicLink()) {
    return { ok: false, error: `${CURRENT()} is a real directory, move it aside first` };
  }
  // symlink() refuses an existing path, so the old link goes first. The window is a few
  // microseconds and only ever yields a 404, never a wrong version.
  if (existing) await unlink(CURRENT()).catch(() => {});
  await symlink(target, CURRENT());
  return { ok: true };
}

export async function runWebCli(args: string[]): Promise<number> {
  const command = args[0];

  if (!command || command === "help") {
    console.log(USAGE);
    return command ? 0 : 1;
  }

  if (command === "ls") {
    const versions = await listVersions();
    if (versions.length === 0) {
      console.log("No bundle installed.");
      return 0;
    }
    const current = await currentVersion();
    for (const version of versions) {
      console.log(`${version === current ? "*" : " "} ${version}`);
    }
    return 0;
  }

  const version = args[1];
  if (!version) {
    console.error(`${command} needs a version`);
    return 1;
  }

  if (command === "install") {
    const fromIndex = args.indexOf("--from");
    const source = fromIndex === -1 ? DEFAULT_SOURCE(version) : args[fromIndex + 1];
    if (!source) {
      console.error("--from needs a url or a path");
      return 1;
    }
    const installed = await installFrom(source, version);
    if (!installed.ok) {
      console.error(installed.error);
      return 1;
    }
    const pointed = await pointCurrentAt(version);
    if (!pointed.ok) {
      console.error(pointed.error);
      return 1;
    }
    console.log(`current -> ${version}`);
    return 0;
  }

  if (command === "use") {
    const pointed = await pointCurrentAt(version);
    if (!pointed.ok) {
      console.error(pointed.error);
      return 1;
    }
    console.log(`current -> ${version}`);
    return 0;
  }

  if (command === "rm") {
    if ((await currentVersion()) === version) {
      console.error(`${version} is the current bundle; point current elsewhere first`);
      return 1;
    }
    await rm(join(WEB_DIR(), version), { recursive: true, force: true });
    console.log(`Removed ${version}`);
    return 0;
  }

  console.log(USAGE);
  return 1;
}
