/**
 * The release layout the clients read, translated to where Forgejo keeps each file. This is the
 * only file that knows Forgejo: a public source one day serves the same layout as plain files.
 *
 *   /server/latest.json                              the newest server release
 *   /server/<v>/my-claw-<v>-linux-x64.tar.gz         its tarball (generic package registry)
 *   /app/latest.json                                 the newest app release
 *   /app/<v>/my-claw-app-v<v>.apk                    its APK (release asset)
 *   /app/<v>/dist-web.tar.gz                         its web bundle (release asset)
 *   /install.sh                                      the installer, at the newest server tag
 */

const OWNER = "claw";
const PACKAGE = "my-claw";
const SERVER_REPO = "claw/my-claw";
const APP_REPO = "claw/my-claw-app";
const VERSION = String.raw`(\d+\.\d+\.\d+)`;

export interface ServerLatest {
  version: string;
  file: string;
  size: number;
  sha256: string;
}

export interface AppLatest {
  version: string;
  apkSize: number;
  web: boolean;
  publishedAt: string;
}

export type Route =
  | { kind: "server-latest" }
  | { kind: "app-latest" }
  | { kind: "install" }
  | { kind: "file"; upstream: string; type: string };

const ROUTES: Array<[RegExp, (v: string) => Route]> = [
  [/^\/server\/latest\.json$/, () => ({ kind: "server-latest" })],
  [/^\/app\/latest\.json$/, () => ({ kind: "app-latest" })],
  [/^\/install\.sh$/, () => ({ kind: "install" })],
  [
    new RegExp(`^/server/${VERSION}/my-claw-\\1-linux-x64\\.tar\\.gz$`),
    (v) => ({
      kind: "file",
      upstream: `/api/packages/${OWNER}/generic/${PACKAGE}/${v}/my-claw-${v}-linux-x64.tar.gz`,
      type: "application/gzip",
    }),
  ],
  [
    new RegExp(`^/app/${VERSION}/my-claw-app-v\\1\\.apk$`),
    (v) => ({
      kind: "file",
      upstream: `/${APP_REPO}/releases/download/v${v}/my-claw-app-v${v}.apk`,
      type: "application/vnd.android.package-archive",
    }),
  ],
  [
    new RegExp(`^/app/${VERSION}/dist-web\\.tar\\.gz$`),
    (v) => ({
      kind: "file",
      upstream: `/${APP_REPO}/releases/download/v${v}/dist-web.tar.gz`,
      type: "application/gzip",
    }),
  ],
];

/** The one place a request path becomes an upstream path. Anything else never reaches Forgejo. */
export function route(path: string): Route | undefined {
  for (const [pattern, build] of ROUTES) {
    const match = pattern.exec(path);
    if (match) return build(match[1] ?? "");
  }
  return undefined;
}

export class UpstreamError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

const isVersion = (v: unknown): v is string => typeof v === "string" && /^\d+\.\d+\.\d+$/.test(v);

/**
 * Two tokens, because Forgejo will not give one both narrow scopes: a token limited to chosen
 * repositories may only carry repository and issue scopes, and the package registry belongs to
 * the owner, not to a repository. So `repo` is limited to the two repositories (read:repository),
 * and `packages` carries read:package alone, which reads no repository at all.
 */
export interface ForgejoTokens {
  repo: string;
  packages: string;
}

const isPackagePath = (path: string): boolean =>
  path.startsWith("/api/packages/") || path.startsWith("/api/v1/packages/");

export class Forgejo {
  constructor(private readonly base: string, private readonly tokens: ForgejoTokens) {}

  fetch(path: string, headers: Record<string, string> = {}): Promise<Response> {
    const token = isPackagePath(path) ? this.tokens.packages : this.tokens.repo;
    return fetch(`${this.base}${path}`, {
      headers: { ...headers, Authorization: `token ${token}` },
    });
  }

  private async json(path: string): Promise<unknown> {
    const response = await this.fetch(path, { Accept: "application/json" });
    if (!response.ok) throw new UpstreamError(response.status, `forgejo answered ${response.status} on ${path}`);
    return response.json();
  }

  /**
   * Forgejo answers 404 both to "not a collaborator" and to a repository the token cannot see: a
   * token without access would refuse everyone and say nothing. Checked once, at startup, with
   * the package token too.
   */
  async checkAccess(): Promise<void> {
    const checks: Array<[string, string]> = [
      [`/api/v1/repos/${SERVER_REPO}`, `FORGEJO_TOKEN cannot read ${SERVER_REPO}`],
      [`/api/v1/repos/${APP_REPO}`, `FORGEJO_TOKEN cannot read ${APP_REPO}`],
      [`/api/v1/packages/${OWNER}?type=generic&q=${PACKAGE}&limit=1`, `FORGEJO_PACKAGE_TOKEN cannot read the ${OWNER} packages`],
    ];
    for (const [path, problem] of checks) {
      const response = await this.fetch(path);
      await response.body?.cancel();
      if (!response.ok) throw new Error(`${problem} (HTTP ${response.status})`);
    }
  }

  /**
   * Access follows the server repository: whoever is a collaborator on it may download, and is
   * cut off once removed. Forgejo answers 204, 404 for an account that is not one, 422 for a name
   * it does not know.
   */
  async isCollaborator(user: string): Promise<boolean> {
    if (!/^[A-Za-z0-9_.-]{1,40}$/.test(user)) return false;
    const response = await this.fetch(`/api/v1/repos/${SERVER_REPO}/collaborators/${user}`);
    await response.body?.cancel();
    if (response.status === 204) return true;
    if (response.status === 404 || response.status === 422) return false;
    throw new UpstreamError(response.status, `forgejo answered ${response.status} on the collaborator check`);
  }

  async serverLatest(): Promise<ServerLatest | undefined> {
    const list = await this.json(`/api/v1/packages/${OWNER}?type=generic&q=${PACKAGE}&limit=50`);
    const versions = (Array.isArray(list) ? list : [])
      .filter((p): p is Record<string, unknown> => typeof p === "object" && p !== null)
      .filter((p) => p["name"] === PACKAGE && p["type"] === "generic")
      .map((p) => p["version"])
      .filter(isVersion)
      .sort(compareVersions);
    const version = versions.at(-1);
    if (!version) return undefined;
    const file = `my-claw-${version}-linux-x64.tar.gz`;
    const files = await this.json(`/api/v1/packages/${OWNER}/generic/${PACKAGE}/${version}/files`);
    // Forgejo spells it `Size`, capitalised, in this one payload.
    const entry = (Array.isArray(files) ? files : []).find(
      (f): f is { name: string; Size: number; sha256: string } =>
        typeof f === "object" && f !== null && (f as { name?: unknown }).name === file,
    );
    if (!entry) return undefined;
    return { version, file, size: entry.Size, sha256: entry.sha256 };
  }

  async appLatest(): Promise<AppLatest | undefined> {
    const releases = await this.json(`/api/v1/repos/${APP_REPO}/releases?limit=20`);
    const candidates = (Array.isArray(releases) ? releases : [])
      .filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null)
      .filter((r) => r["draft"] !== true && r["prerelease"] !== true)
      .flatMap((r) => {
        const version = typeof r["tag_name"] === "string" ? r["tag_name"].replace(/^v/, "") : "";
        if (!isVersion(version)) return [];
        const assets = (Array.isArray(r["assets"]) ? r["assets"] : []) as Array<{ name?: unknown; size?: unknown }>;
        const apk = assets.find((a) => a.name === `my-claw-app-v${version}.apk`);
        if (!apk) return [];
        return [{
          version,
          apkSize: typeof apk.size === "number" ? apk.size : 0,
          web: assets.some((a) => a.name === "dist-web.tar.gz"),
          publishedAt: typeof r["published_at"] === "string" ? r["published_at"] : "",
        }];
      })
      .sort((a, b) => compareVersions(a.version, b.version));
    return candidates.at(-1);
  }

  async installer(): Promise<Response> {
    const latest = await this.serverLatest();
    if (!latest) throw new UpstreamError(404, "no server release");
    return this.fetch(`/api/v1/repos/${SERVER_REPO}/raw/packaging/install-remote.sh?ref=v${latest.version}`);
  }
}
