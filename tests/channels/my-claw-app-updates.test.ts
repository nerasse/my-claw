import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { resetAppUpdateCache, latestAppUpdate, streamAppApk } from "../../src/channels/my-claw-app/updates.ts";
import { mockFetch } from "../helpers/mock-fetch.ts";

/**
 * The app-update relay: the server holds the release key, asks its release source (dl-hub,
 * docs/release-source.md) for the newest release, and streams the APK through. The phone never
 * builds a source URL and never sees the key. Picking the newest release (drafts, pre-releases,
 * versions over dates) is dl-hub's job and tested there; here, only what the server makes of it.
 */

const HUB = "https://dl.example.test/my-claw";
const KEY = "dlh_test-key";

function latest(version: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version,
    publishedAt: "2026-10-09T20:20:20+02:00",
    files: [{ name: `my-claw-app-v${version}.apk`, size: 46936461 }, { name: "dist-web.tar.gz", size: 1539691 }],
    ...extra,
  };
}

type Seen = Array<{ url: string; headers?: Record<string, string> }>;
function record(answer: () => Response): { seen: Seen; restore(): void } {
  const seen: Seen = [];
  const mock = mockFetch(async (input, init) => {
    seen.push({ url: String(input), headers: init?.headers as Record<string, string> | undefined });
    return answer();
  });
  return { seen, restore: () => mock.restore() };
}

beforeEach(() => {
  process.env["MY_CLAW_RELEASE_URL"] = `${HUB}/`;
  process.env["MY_CLAW_RELEASE_KEY"] = KEY;
  resetAppUpdateCache();
});

afterEach(() => {
  delete process.env["MY_CLAW_RELEASE_URL"];
  delete process.env["MY_CLAW_RELEASE_KEY"];
  delete process.env["FORGEJO_URL"];
  delete process.env["FORGEJO_TOKEN"];
  resetAppUpdateCache();
});

describe("latestAppUpdate", () => {
  test("reads app/latest.json with the key, on the source only, and keeps the wire shape", async () => {
    const fetchMock = record(() => Response.json(latest("0.6.143")));
    try {
      expect(await latestAppUpdate()).toEqual({
        ok: true, version: "0.6.143", apkSize: 46936461, publishedAt: "2026-10-09T20:20:20+02:00",
      });
    } finally {
      fetchMock.restore();
    }
    expect(fetchMock.seen).toEqual([
      { url: `${HUB}/app/latest.json`, headers: { Accept: "application/json", Authorization: `Bearer ${KEY}` } },
    ]);
  });

  test("a latest release without its APK, or not a version, is no update", async () => {
    let answer = latest("0.6.144", { files: [{ name: "dist-web.tar.gz", size: 1 }] });
    const fetchMock = record(() => Response.json(answer));
    try {
      expect(await latestAppUpdate(true)).toEqual({ ok: false, error: "no app release found" });
      answer = latest("nightly");
      expect(await latestAppUpdate(true)).toEqual({ ok: false, error: "no app release found" });
    } finally {
      fetchMock.restore();
    }
  });

  test("caches for five minutes and force bypasses", async () => {
    const fetchMock = record(() => Response.json(latest("0.6.143")));
    try {
      await latestAppUpdate();
      await latestAppUpdate();
      expect(fetchMock.seen).toHaveLength(1);
      await latestAppUpdate(true);
      expect(fetchMock.seen).toHaveLength(2);
    } finally {
      fetchMock.restore();
    }
  });

  test("answers an explicit error, without a request, when no source is configured", async () => {
    delete process.env["MY_CLAW_RELEASE_URL"];
    // A forge token alone is no source any more: the installs trade it for a key (0.7.103).
    process.env["FORGEJO_URL"] = "https://git.example.test";
    process.env["FORGEJO_TOKEN"] = "forge-secret";
    const fetchMock = record(() => Response.json([]));
    try {
      expect(await latestAppUpdate()).toEqual({ ok: false, error: "no release source on the server: run `myclaw release-key --url https://github.com/<owner>/my-claw`" });
    } finally {
      fetchMock.restore();
    }
    expect(fetchMock.seen).toEqual([]);
  });

  test("a refused key or a failing source says so", async () => {
    let status = 401;
    const fetchMock = record(() => new Response("nope", { status }));
    try {
      expect(await latestAppUpdate(true)).toEqual({ ok: false, error: "release source answered HTTP 401" });
      status = 503;
      expect(await latestAppUpdate(true)).toEqual({ ok: false, error: "release source answered HTTP 503" });
    } finally {
      fetchMock.restore();
    }
  });
});

describe("streamAppApk", () => {
  test("streams the APK from the source's path, with the key and the archive content type", async () => {
    const fetchMock = record(() => new Response("PK\x03\x04fake-bytes", { status: 200 }));
    try {
      const res = await streamAppApk({ ok: true, version: "0.6.143", apkSize: 11, publishedAt: "" });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/vnd.android.package-archive");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.text()).toBe("PK\x03\x04fake-bytes");
    } finally {
      fetchMock.restore();
    }
    expect(fetchMock.seen).toEqual([
      { url: `${HUB}/app/0.6.143/my-claw-app-v0.6.143.apk`, headers: { Authorization: `Bearer ${KEY}` } },
    ]);
  });

  test("the upstream's own length wins over the size the cached check carried", async () => {
    // Seen on 2026-10-23: latest.json still advertised the previous APK's size for 0.6.167, the
    // relay repeated it, the phone downloaded the real file and rejected it as truncated. The
    // bytes are the authority; the check's size is only a fallback for a chunked upstream.
    const apk = "PK\x03\x04fake-bytes";
    const upstreamLength = String(new TextEncoder().encode(apk).length);
    const fetchMock = record(() => new Response(apk, { status: 200, headers: { "content-length": upstreamLength } }));
    try {
      const res = await streamAppApk({ ok: true, version: "0.6.167", apkSize: 999, publishedAt: "" });
      expect(res.headers.get("content-length")).toBe(upstreamLength);
      expect(await res.text()).toBe(apk);
    } finally {
      fetchMock.restore();
    }
  });

  test("a chunked upstream leaves the length to the check's size", async () => {
    // No upstream length to trust: the relay stays chunked and the phone falls back to the size
    // the check reported, which is the only number left.
    const fetchMock = record(() => new Response("PK\x03\x04fake-bytes", { status: 200 }));
    try {
      const res = await streamAppApk({ ok: true, version: "0.6.167", apkSize: 14, publishedAt: "" });
      expect(res.headers.get("content-length")).toBeNull();
    } finally {
      fetchMock.restore();
    }
  });

  test("turns an upstream failure into 502", async () => {
    const fetchMock = record(() => new Response("not found", { status: 404 }));
    try {
      const res = await streamAppApk({ ok: true, version: "0.6.143", apkSize: 11, publishedAt: "" });
      expect(res.status).toBe(502);
    } finally {
      fetchMock.restore();
    }
  });
});
