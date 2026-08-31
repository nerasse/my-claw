import { APP_REPO, authHeaders, forgeBase, forgeToken } from "./forge.ts";
import { myClawAppLog } from "../../utils/logger.ts";

/**
 * The app-update relay: the server is the only thing that holds the Forgejo token, so the phone
 * asks its own server and the server reaches into the private releases. The phone never sees the
 * credential, and a release is served through the same authenticated surface as media.
 *
 * The wire shape is deliberately small and version-ish: `{ ok: true, version, apkSize,
 * publishedAt }` or `{ ok: false, error }`. The client compares `version` with its own
 * `versionName` and decides; everything else is presentation.
 */

export interface AppUpdateOk {
  ok: true;
  version: string;
  apkSize: number;
  publishedAt: string;
}

export interface AppUpdateError {
  ok: false;
  error: string;
}

export type AppUpdateInfo = AppUpdateOk | AppUpdateError;

/** The release property carries no cacheable asset URL; the app never builds one. */
const RELEASES_LIST = (): string =>
  `${forgeBase()}/api/v1/repos/${APP_REPO}/releases?limit=20`;

const ASSET_PATTERN = /^my-claw-app-v[0-9]+\.[0-9]+\.[0-9]+\.apk$/;

let cached: { at: number; value: AppUpdateInfo } | undefined;

const CACHE_TTL_MS = 5 * 60 * 1000;

/** A release that carries the APK and is not a draft or a pre-release, newest first. */
function pickRelease(releases: unknown): AppUpdateOk | undefined {
  if (!Array.isArray(releases)) return undefined;
  const candidates = releases
    .filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null)
    .filter((r) => r["draft"] !== true && r["prerelease"] !== true)
    .map((r) => {
      const assets = Array.isArray(r["assets"]) ? (r["assets"] as unknown[]) : [];
      const apk = assets.find(
        (a): a is { name: string; size?: number } =>
          typeof a === "object" && a !== null && typeof (a as { name?: unknown })["name"] === "string"
          && ASSET_PATTERN.test((a as { name: string })["name"]),
      );
      return {
        tag: typeof r["tag_name"] === "string" ? r["tag_name"] : "",
        name: apk?.["name"] ?? "",
        size: typeof apk?.["size"] === "number" ? apk["size"] : 0,
        publishedAt: typeof r["published_at"] === "string" ? r["published_at"] : "",
      };
    })
    .filter((r) => r.tag.length > 0 && r.name.length > 0)
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  const best = candidates[0];
  if (!best) return undefined;
  return {
    ok: true,
    version: best.tag.replace(/^v/, ""),
    apkSize: best.size,
    publishedAt: best.publishedAt,
  };
}

async function fetchLatest(): Promise<AppUpdateInfo> {
  const token = forgeToken();
  if (!token) {
    return { ok: false, error: "FORGEJO_TOKEN is not set on the server" };
  }
  const response = await fetch(RELEASES_LIST(), { headers: { Authorization: `token ${token}` } });
  if (!response.ok) {
    return { ok: false, error: `forge answered HTTP ${response.status}` };
  }
  const body: unknown = await response.json().catch(() => undefined);
  const picked = pickRelease(body);
  if (!picked) {
    return { ok: false, error: "no app release found" };
  }
  return picked;
}

/** Last release info, cached for a few minutes so every device check does not hammer the forge. */
export async function latestAppUpdate(force = false): Promise<AppUpdateInfo> {
  if (!force && cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;
  const value = await fetchLatest();
  cached = { at: Date.now(), value };
  void myClawAppLog("info", "app update check", { ok: value.ok, version: value.ok ? value.version : undefined, size: value.ok ? value.apkSize : undefined, error: value.ok ? undefined : value.error });
  return value;
}

/** A test hook: the cache holds module state and must not leak across files. */
export function resetAppUpdateCache(): void {
  cached = undefined;
}

/**
 * Streams the APK bytes through the server: the body of the forge response is forwarded as-is,
 * never buffered — a 45 MB archive must not live in memory twice.
 */
export async function streamAppApk(info: AppUpdateOk): Promise<Response> {
  const version = info.version;
  const apkUrl = `${forgeBase()}/claw/${APP_REPO}/releases/download/v${version}/my-claw-app-v${version}.apk`;
  // A freshly published asset can briefly answer 404 behind the proxy (release.sh and the
  // registry race). One retry after a half second is enough; a stable 404 stays a 502.
  let upstream = await fetch(apkUrl, { headers: authHeaders(apkUrl) });
  if (upstream.status === 404) {
    await new Promise(r => setTimeout(r, 500));
    upstream = await fetch(apkUrl, { headers: authHeaders(apkUrl) });
  }
  if (!upstream.ok || !upstream.body) {
    void myClawAppLog("warn", "app update apk upstream failed", { status: upstream.status });
    return new Response("upstream failed", { status: 502 });
  }
  void myClawAppLog("info", "app update served", { version, size: info.apkSize });
  return new Response(upstream.body, {
    status: 200,
    headers: {
      "content-type": "application/vnd.android.package-archive",
      "content-length": String(info.apkSize),
      "cache-control": "no-store",
    },
  });
}
