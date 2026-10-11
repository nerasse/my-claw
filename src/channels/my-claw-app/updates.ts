import { appFileUrl, authHeaders, latestAppRelease } from "./release-source.ts";
import { myClawAppLog } from "../../utils/logger.ts";

/**
 * The app-update relay: the server is the only thing that holds the release credential, so the
 * phone asks its own server and the server reaches into the release source. The phone never sees the
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

let cached: { at: number; value: AppUpdateInfo } | undefined;

const CACHE_TTL_MS = 5 * 60 * 1000;

async function fetchLatest(): Promise<AppUpdateInfo> {
  const result = await latestAppRelease();
  if (!result.ok) return result;
  const { version, apkSize, publishedAt } = result.release;
  return { ok: true, version, apkSize, publishedAt };
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
 * Streams the APK bytes through the server: the body of the source's response is forwarded as-is,
 * never buffered — a 45 MB archive must not live in memory twice.
 */
export async function streamAppApk(info: AppUpdateOk): Promise<Response> {
  const version = info.version;
  const apkUrl = appFileUrl(version, "apk");
  if (!apkUrl) return new Response("no release source", { status: 502 });
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
