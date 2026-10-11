/**
 * Where the app's releases (APK, web bundle) come from: docs/release-source.md. The shell updaters
 * read the same two sources, in packaging/release-source.sh.
 *
 *   MY_CLAW_RELEASE_URL (+ MY_CLAW_RELEASE_KEY)  the neutral layout dl-hub serves:
 *                                                <url>/app/latest.json, <url>/app/<v>/<file>
 *   FORGEJO_URL + FORGEJO_TOKEN                  the forge itself, for the installs set up before
 *                                                keys existed; removed once none is left
 *
 * The credential only ever travels to the source itself: a `--from` pointing at a mirror is a
 * plain download, never a credential handover.
 */

const APP_REPO = "claw/my-claw-app";

export type ReleaseSource =
  | { kind: "hub"; base: string; key?: string }
  | { kind: "forge"; base: string; token: string };

const trim = (url: string): string => url.replace(/\/+$/, "");
const env = (name: string): string | undefined => {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
};

export function releaseSource(): ReleaseSource | undefined {
  const url = env("MY_CLAW_RELEASE_URL");
  if (url) {
    const key = env("MY_CLAW_RELEASE_KEY");
    return { kind: "hub", base: trim(url), ...(key ? { key } : {}) };
  }
  const forge = env("FORGEJO_URL");
  const token = env("FORGEJO_TOKEN");
  if (forge && token) return { kind: "forge", base: trim(forge), token };
  return undefined;
}

export function authHeaders(url: string, source = releaseSource()): Record<string, string> {
  if (!source) return {};
  const secret = source.kind === "hub" ? source.key : source.token;
  if (!secret) return {};
  try {
    const target = new URL(url);
    const home = new URL(source.base);
    if (target.origin !== home.origin) return {};
    return { Authorization: source.kind === "hub" ? `Bearer ${secret}` : `token ${secret}` };
  } catch {
    return {};
  }
}

export interface AppRelease {
  version: string;
  apkSize: number;
  publishedAt: string;
  web: boolean;
}

export type AppReleaseResult = { ok: true; release: AppRelease } | { ok: false; error: string };

const isVersion = (v: unknown): v is string => typeof v === "string" && /^\d+\.\d+\.\d+$/.test(v);
type Raw = Record<string, unknown>;
const records = (value: unknown): Raw[] =>
  (Array.isArray(value) ? value : []).filter((v): v is Raw => typeof v === "object" && v !== null);

const apkName = (version: string) => `my-claw-app-v${version}.apk`;

/** dl-hub has already picked the newest release: it only has to carry the APK. */
function fromHub(body: unknown): AppRelease | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const raw = body as Raw;
  if (!isVersion(raw["version"])) return undefined;
  const files = records(raw["files"]);
  const apk = files.find((f) => f["name"] === apkName(raw["version"] as string));
  if (!apk) return undefined;
  return {
    version: raw["version"],
    apkSize: typeof apk["size"] === "number" ? apk["size"] : 0,
    publishedAt: typeof raw["publishedAt"] === "string" ? raw["publishedAt"] : "",
    web: files.some((f) => f["name"] === "dist-web.tar.gz"),
  };
}

/** The newest published release carrying its APK, drafts and pre-releases left out. */
function fromForge(body: unknown): AppRelease | undefined {
  return records(body)
    .filter((r) => r["draft"] !== true && r["prerelease"] !== true)
    .flatMap((r): AppRelease[] => {
      const version = typeof r["tag_name"] === "string" ? r["tag_name"].replace(/^v/, "") : "";
      if (!isVersion(version)) return [];
      const assets = records(r["assets"]);
      const apk = assets.find((a) => a["name"] === apkName(version));
      if (!apk) return [];
      return [{
        version,
        apkSize: typeof apk["size"] === "number" ? apk["size"] : 0,
        publishedAt: typeof r["published_at"] === "string" ? r["published_at"] : "",
        web: assets.some((a) => a["name"] === "dist-web.tar.gz"),
      }];
    })
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))[0];
}

export async function latestAppRelease(source = releaseSource()): Promise<AppReleaseResult> {
  if (!source) return { ok: false, error: "no release source on the server: run `myclaw release-key <key>`" };
  const url = source.kind === "hub" ? `${source.base}/app/latest.json` : `${source.base}/api/v1/repos/${APP_REPO}/releases?limit=20`;
  const response = await fetch(url, { headers: { Accept: "application/json", ...authHeaders(url, source) } });
  if (!response.ok) {
    await response.body?.cancel();
    return { ok: false, error: `release source answered HTTP ${response.status}` };
  }
  const body: unknown = await response.json().catch(() => undefined);
  const release = source.kind === "hub" ? fromHub(body) : fromForge(body);
  return release ? { ok: true, release } : { ok: false, error: "no app release found" };
}

/** `version` with or without its `v`. */
export function appFileUrl(version: string, file: "apk" | "web", source = releaseSource()): string | undefined {
  if (!source) return undefined;
  const v = version.replace(/^v/, "");
  const name = file === "apk" ? apkName(v) : "dist-web.tar.gz";
  return source.kind === "hub"
    ? `${source.base}/app/${v}/${name}`
    : `${source.base}/${APP_REPO}/releases/download/v${v}/${name}`;
}
