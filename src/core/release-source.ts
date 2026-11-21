/**
 * Where releases come from: docs/release-source.md.
 *
 * Two shapes. A GitHub repository URL resolves the newest tag from the `/releases/latest`
 * redirect and builds asset URLs from it: no API, no token, no rate limit. Anything else keeps
 * the neutral layout a self-hosted hub serves, where a key may guard it.
 *
 * The old `https://dl.kssimi.fr/my-claw` now means the GitHub repository: it is mapped here so an
 * install that still carries it in `.env` starts reading GitHub on its next check, without a
 * rewrite step that could fail halfway.
 */

export interface ReleaseSource {
  kind: "github" | "layout";
  /** The server repository, or the layout base. No trailing slash. */
  server: string;
  /** Where the APK and the web bundle live: a sibling repository, or the same base. */
  app: string;
  key?: string;
}

export const DEFAULT_RELEASE_URL = "https://github.com/nerasse/my-claw";
const LEGACY_RELEASE_URL = "https://dl.kssimi.fr/my-claw";

const env = (name: string): string | undefined => {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
};

const trim = (url: string): string => url.replace(/\/+$/, "");

export function normalizeReleaseUrl(url: string): string {
  const trimmed = trim(url);
  return trimmed === LEGACY_RELEASE_URL ? DEFAULT_RELEASE_URL : trimmed;
}

function githubRepo(url: string): { owner: string; repo: string } | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.hostname !== "github.com") return undefined;
  const [owner, repo] = parsed.pathname.replace(/^\/+|\/+$/g, "").split("/");
  return owner && repo ? { owner, repo } : undefined;
}

export function isGithubSource(url: string): boolean {
  return githubRepo(normalizeReleaseUrl(url)) !== undefined;
}

export function releaseSource(): ReleaseSource | undefined {
  const configured = env("MY_CLAW_RELEASE_URL");
  if (!configured) return undefined;
  const url = normalizeReleaseUrl(configured);
  const repo = githubRepo(url);
  if (!repo) {
    const key = env("MY_CLAW_RELEASE_KEY");
    return { kind: "layout", server: url, app: url, ...(key ? { key } : {}) };
  }
  const app = env("MY_CLAW_APP_RELEASE_URL") ?? `https://github.com/${repo.owner}/${repo.repo}-app`;
  return { kind: "github", server: url, app: normalizeReleaseUrl(app) };
}

/** The key only travels to the layout it was issued for, over the same origin and scheme. */
export function authHeaders(url: string, source = releaseSource()): Record<string, string> {
  if (!source || source.kind !== "layout" || !source.key) return {};
  try {
    const target = new URL(url);
    const home = new URL(source.server);
    if (target.origin !== home.origin) return {};
    return { Authorization: `Bearer ${source.key}` };
  } catch {
    return {};
  }
}

/** The newest tag of a repository, without its `v`, read off the /releases/latest redirect. */
export async function githubLatestVersion(repo: string): Promise<string | undefined> {
  try {
    const response = await fetch(`${trim(repo)}/releases/latest`, {
      redirect: "manual",
      headers: { Accept: "text/html" },
      signal: AbortSignal.timeout(20_000),
    });
    await response.body?.cancel();
    const tag = (response.headers.get("location") ?? "").split("/").pop() ?? "";
    return /^v?\d+\.\d+\.\d+$/.test(tag) ? tag.replace(/^v/, "") : undefined;
  } catch {
    return undefined;
  }
}

async function layoutVersion(url: string, source: ReleaseSource): Promise<string | undefined> {
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json", ...authHeaders(url, source) },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return undefined;
    }
    const body = (await response.json().catch(() => undefined)) as { version?: unknown } | undefined;
    return typeof body?.version === "string" && /^\d+\.\d+\.\d+$/.test(body.version) ? body.version : undefined;
  } catch {
    return undefined;
  }
}

export async function latestServerVersion(source = releaseSource()): Promise<string | undefined> {
  if (!source) return undefined;
  if (source.kind === "github") return githubLatestVersion(source.server);
  return layoutVersion(`${source.server}/server/latest.json`, source);
}

/** The node binaries ship with the server on GitHub; a layout keeps its own `node` component. */
export async function latestNodeVersion(source = releaseSource()): Promise<string | undefined> {
  if (!source) return undefined;
  if (source.kind === "github") return githubLatestVersion(source.server);
  return layoutVersion(`${source.server}/node/latest.json`, source);
}

const versionOf = (version: string): string => version.replace(/^v/, "");

export function serverTarballUrl(version: string, source = releaseSource()): string | undefined {
  if (!source) return undefined;
  const v = versionOf(version);
  const name = `my-claw-${v}-linux-x64.tar.gz`;
  return source.kind === "github"
    ? `${source.server}/releases/download/v${v}/${name}`
    : `${source.server}/server/${v}/${name}`;
}

export function nodeAssetUrl(version: string, name: string, source = releaseSource()): string | undefined {
  if (!source) return undefined;
  const v = versionOf(version);
  return source.kind === "github"
    ? `${source.server}/releases/download/v${v}/${name}`
    : `${source.server}/node/${v}/${name}`;
}

export function appAssetUrl(version: string, name: string, source = releaseSource()): string | undefined {
  if (!source) return undefined;
  const v = versionOf(version);
  return source.kind === "github"
    ? `${source.app}/releases/download/v${v}/${name}`
    : `${source.app}/app/${v}/${name}`;
}
