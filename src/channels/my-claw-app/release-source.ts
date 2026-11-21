/**
 * The app's releases (APK, web bundle), read off the source described in docs/release-source.md.
 * The server half lives in core/release-source.ts; this file only knows the two asset names and
 * what the update relay needs.
 */

import { appAssetUrl, authHeaders, githubLatestVersion, releaseSource, type ReleaseSource } from "../../core/release-source.ts";

export { authHeaders, releaseSource };
export type { ReleaseSource };

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

async function head(url: string): Promise<{ ok: boolean; size: number }> {
  try {
    const response = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(20_000) });
    await response.body?.cancel();
    return { ok: response.ok, size: Number(response.headers.get("content-length") ?? 0) || 0 };
  } catch {
    return { ok: false, size: 0 };
  }
}

/** The layout hub has already picked the newest release: it only has to carry the APK. */
function fromLatest(body: unknown): AppRelease | undefined {
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

export async function latestAppRelease(source = releaseSource()): Promise<AppReleaseResult> {
  if (!source) {
    return { ok: false, error: "no release source on the server: run `myclaw release-key --url https://github.com/<owner>/my-claw`" };
  }
  if (source.kind === "github") {
    const version = await githubLatestVersion(source.app);
    if (!version) return { ok: false, error: "no app release found on GitHub" };
    const apk = appAssetUrl(version, apkName(version), source)!;
    const apkHead = await head(apk);
    if (!apkHead.ok) return { ok: false, error: `the latest app release has no ${apkName(version)}` };
    const web = await head(appAssetUrl(version, "dist-web.tar.gz", source)!);
    return { ok: true, release: { version, apkSize: apkHead.size, publishedAt: "", web: web.ok } };
  }

  const url = `${source.app}/app/latest.json`;
  const response = await fetch(url, { headers: { Accept: "application/json", ...authHeaders(url, source) } });
  if (!response.ok) {
    await response.body?.cancel();
    return { ok: false, error: `release source answered HTTP ${response.status}` };
  }
  const body: unknown = await response.json().catch(() => undefined);
  const release = fromLatest(body);
  return release ? { ok: true, release } : { ok: false, error: "no app release found" };
}

/** `version` with or without its `v`. */
export function appFileUrl(version: string, file: "apk" | "web", source = releaseSource()): string | undefined {
  const v = version.replace(/^v/, "");
  const name = file === "apk" ? apkName(v) : "dist-web.tar.gz";
  return appAssetUrl(v, name, source);
}
