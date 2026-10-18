import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * ripgrep, the engine behind `search` (docs/search.md).
 *
 * One pinned build per platform, each carrying the release's own SHA-256. Resolution order:
 * `MY_CLAW_RG_PATH`, the vendor directory of an installed tree (the release ships the linux-x64
 * build), the machine's cache, PATH, then a single download. A machine with neither network nor
 * ripgrep is not broken: the tool falls back to GNU grep and says so in the result.
 */
export const RIPGREP_VERSION = "14.1.1";

const RELEASE_BASE = `https://github.com/BurntSushi/ripgrep/releases/download/${RIPGREP_VERSION}`;

interface Target {
  asset: string;
  archive: "tar.gz" | "zip";
  sha256: string;
}

const TARGETS: Record<string, Target> = {
  "linux-x64": {
    asset: "x86_64-unknown-linux-musl",
    archive: "tar.gz",
    sha256: "4cf9f2741e6c465ffdb7c26f38056a59e2a2544b51f7cc128ef28337eeae4d8e",
  },
  "linux-arm64": {
    asset: "aarch64-unknown-linux-gnu",
    archive: "tar.gz",
    sha256: "c827481c4ff4ea10c9dc7a4022c8de5db34a5737cb74484d62eb94a95841ab2f",
  },
  "darwin-x64": {
    asset: "x86_64-apple-darwin",
    archive: "tar.gz",
    sha256: "fc87e78f7cb3fea12d69072e7ef3b21509754717b746368fd40d88963630e2b3",
  },
  "darwin-arm64": {
    asset: "aarch64-apple-darwin",
    archive: "tar.gz",
    sha256: "24ad76777745fbff131c8fbc466742b011f925bfa4fffa2ded6def23b5b937be",
  },
  "windows-x64": {
    asset: "x86_64-pc-windows-msvc",
    archive: "zip",
    sha256: "d0f534024c42afd6cb4d38907c25cd2b249b79bbe6cc1dbee8e3e37c2b6e25a1",
  },
};

export function hostTarget(platform = process.platform, arch = process.arch): string | null {
  const key = `${platform}-${arch}`;
  return key in TARGETS ? key : null;
}

export interface RipgrepResolution {
  path: string;
  source: "env" | "vendor" | "cache" | "path" | "download";
}

export function ripgrepExeName(platform = process.platform): string {
  return platform === "win32" ? "rg.exe" : "rg";
}

/** One attempt per process: a machine that just failed a download is not asked again on every call. */
let downloadAttempted = false;

export function resetRipgrepDownloadForTests(): void {
  downloadAttempted = false;
}

export async function resolveRipgrep(options: {
  vendorDir?: string | null;
  cacheDir?: string | null;
  allowDownload?: boolean;
} = {}): Promise<RipgrepResolution | null> {
  const exe = ripgrepExeName();

  const env = process.env.MY_CLAW_RG_PATH;
  if (env && existsSync(env)) return { path: env, source: "env" };

  if (options.vendorDir) {
    const bundled = join(options.vendorDir, exe);
    if (existsSync(bundled)) return { path: bundled, source: "vendor" };
  }

  if (options.cacheDir) {
    const cached = join(options.cacheDir, RIPGREP_VERSION, exe);
    if (existsSync(cached)) return { path: cached, source: "cache" };
  }

  const onPath = Bun.which("rg");
  if (onPath) return { path: onPath, source: "path" };

  if (options.allowDownload && options.cacheDir && !downloadAttempted) {
    downloadAttempted = true;
    const downloaded = await downloadRipgrep(options.cacheDir);
    if (downloaded) return { path: downloaded, source: "download" };
  }

  return null;
}

export async function downloadRipgrep(cacheDir: string): Promise<string | null> {
  const target = hostTarget();
  if (!target) return null;
  const entry = TARGETS[target]!;
  const exe = ripgrepExeName();
  const destDir = join(cacheDir, RIPGREP_VERSION);
  const dest = join(destDir, exe);
  const archiveName = `ripgrep-${RIPGREP_VERSION}-${entry.asset}.${entry.archive}`;

  try {
    const response = await fetch(`${RELEASE_BASE}/${archiveName}`);
    if (!response.ok) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(bytes);
    if (hasher.digest("hex") !== entry.sha256) return null;

    const scratch = await mkdtemp(join(tmpdir(), "my-claw-rg-"));
    try {
      const extractedDir = join(scratch, "x");
      await mkdir(extractedDir);
      const archivePath = join(scratch, archiveName);
      await writeFile(archivePath, bytes);
      const tar = Bun.which("tar");
      if (!tar) return null;
      const unpack = Bun.spawn([tar, "-xf", archivePath, "-C", extractedDir], { stdout: "ignore", stderr: "ignore" });
      if ((await unpack.exited) !== 0) return null;
      const [top] = await readdir(extractedDir);
      if (!top) return null;
      const binary = join(extractedDir, top, exe);
      if (!existsSync(binary)) return null;

      // A partial file must never land where a later boot would trust it: stage beside the
      // destination, then rename.
      await mkdir(destDir, { recursive: true });
      const staging = `${dest}.staging-${process.pid}`;
      await copyFile(binary, staging);
      if (process.platform !== "win32") await chmod(staging, 0o755);
      await rename(staging, dest);
      return dest;
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  } catch {
    return null;
  }
}
