import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { resetAppUpdateCache, latestAppUpdate, streamAppApk } from "../../src/channels/my-claw-app/updates.ts";
import { mockFetch } from "../helpers/mock-fetch.ts";

/**
 * The app-update relay: the server holds the release credential, asks its release source for the
 * newest release that carries an APK, and streams the bytes through. The phone never builds a
 * source URL and never sees the credential. Two sources (docs/release-source.md): dl-hub, and the
 * forge directly for the installs that have no key yet.
 */

const FORGE = "https://git.example.test";
const TOKEN = "forge-secret";

function release(tag: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tag_name: tag,
    draft: false,
    prerelease: false,
    published_at: `2026-08-30T12:00:00Z`,
    assets: [{ name: `my-claw-app-v${tag.slice(1)}.apk`, size: 45438191 }],
    ...extra,
  };
}

beforeEach(() => {
  delete process.env["FORGEJO_TOKEN"];
  delete process.env["FORGEJO_URL"];
  process.env["FORGEJO_TOKEN"] = TOKEN;
  process.env["FORGEJO_URL"] = FORGE;
  resetAppUpdateCache();
});

afterEach(() => {
  delete process.env["FORGEJO_TOKEN"];
  delete process.env["FORGEJO_URL"];
  delete process.env["MY_CLAW_RELEASE_URL"];
  delete process.env["MY_CLAW_RELEASE_KEY"];
  resetAppUpdateCache();
});

describe("latestAppUpdate", () => {
  test("picks the newest release that carries an APK", async () => {
    const seen: string[] = [];
    const fetchMock = mockFetch(async (input) => {
      seen.push(String(input));
      return Response.json([
        release("v0.5.51"),
        release("v0.5.53", { published_at: "2026-08-30T13:00:00Z" }),
        release("v0.5.52", { published_at: "2026-08-30T12:30:00Z" }),
      ]);
    });
    try {
      const info = await latestAppUpdate();
      expect(info).toEqual({
        ok: true,
        version: "0.5.53",
        apkSize: 45438191,
        publishedAt: "2026-08-30T13:00:00Z",
      });
      // The release list is read with the credential, on the forge only.
      expect(seen[0]).toBe(`${FORGE}/api/v1/repos/claw/my-claw-app/releases?limit=20`);
    } finally {
      fetchMock.restore();
    }
  });

  test("skips drafts, pre-releases and releases without an APK asset", async () => {
    const fetchMock = mockFetch(async () =>
      Response.json([
        release("v0.5.99", { draft: true }),
        release("v0.5.98", { prerelease: true }),
        release("v0.5.97", { assets: [{ name: "dist-web.tar.gz", size: 1087727 }] }),
        release("v0.5.55", { published_at: "2026-08-30T12:00:00Z" }),
      ]),
    );
    try {
      const info = await latestAppUpdate();
      expect(info).toMatchObject({ ok: true, version: "0.5.55" });
    } finally {
      fetchMock.restore();
    }
  });

  test("caches for five minutes and force bypasses", async () => {
    let calls = 0;
    const fetchMock = mockFetch(async () => {
      calls += 1;
      return Response.json([release("v0.5.55")]);
    });
    try {
      await latestAppUpdate();
      await latestAppUpdate();
      expect(calls).toBe(1);
      await latestAppUpdate(true);
      expect(calls).toBe(2);
    } finally {
      fetchMock.restore();
    }
  });

  test("answers an explicit error, without a request, when no source is configured", async () => {
    delete process.env["FORGEJO_TOKEN"];
    const seen: string[] = [];
    const fetchMock = mockFetch(async (input) => {
      seen.push(String(input));
      return Response.json([]);
    });
    try {
      const info = await latestAppUpdate();
      expect(info).toEqual({ ok: false, error: "no release source on the server: run `myclaw release-key <key>`" });
      expect(seen).toEqual([]);
    } finally {
      fetchMock.restore();
    }
  });

  test("answers an explicit error when the forge answers non-2xx", async () => {
    const fetchMock = mockFetch(async () => new Response("nope", { status: 503 }));
    try {
      const info = await latestAppUpdate();
      expect(info).toEqual({ ok: false, error: "release source answered HTTP 503" });
    } finally {
      fetchMock.restore();
    }
  });

  test("sends the credential to the forge only, not to a third host", async () => {
    const seen: Array<{ url: string; headers?: Record<string, string> }> = [];
    const fetchMock = mockFetch(async (input, init) => {
      seen.push({ url: String(input), headers: init?.headers as Record<string, string> | undefined });
      return Response.json([release("v0.5.55")]);
    });
    try {
      await latestAppUpdate();
    } finally {
      fetchMock.restore();
    }
    expect(seen).toEqual([
      {
        url: `${FORGE}/api/v1/repos/claw/my-claw-app/releases?limit=20`,
        headers: { Accept: "application/json", Authorization: `token ${TOKEN}` },
      },
    ]);
  });
});

describe("streamAppApk", () => {
  test("streams the body with the archive content type", async () => {
    const seen: string[] = [];
    const fetchMock = mockFetch(async (input) => {
      seen.push(String(input));
      return new Response("PK\x03\x04fake-bytes", { status: 200 });
    });
    try {
      const res = await streamAppApk({ ok: true, version: "0.5.55", apkSize: 11, publishedAt: "" });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/vnd.android.package-archive");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.text()).toBe("PK\x03\x04fake-bytes");
    } finally {
      fetchMock.restore();
    }
    // The exact download path: one owner segment, not two. APP_REPO already carries claw/,
    // so a second claw/ prefix is a 404 that no mock would ever see.
    expect(seen).toEqual([
      `${FORGE}/claw/my-claw-app/releases/download/v0.5.55/my-claw-app-v0.5.55.apk`,
    ]);
  });

  test("turns an upstream failure into 502", async () => {
    const fetchMock = mockFetch(async () => new Response("not found", { status: 404 }));
    try {
      const res = await streamAppApk({ ok: true, version: "0.5.55", apkSize: 11, publishedAt: "" });
      expect(res.status).toBe(502);
    } finally {
      fetchMock.restore();
    }
  });
});

describe("from dl-hub", () => {
  const HUB = "https://dl.example.test/my-claw";
  const KEY = "dlh_test-key";

  beforeEach(() => {
    // The hub wins over the forge: an install that has a key no longer reads the forge at all.
    process.env["MY_CLAW_RELEASE_URL"] = `${HUB}/`;
    process.env["MY_CLAW_RELEASE_KEY"] = KEY;
  });

  test("reads app/latest.json with the key, and keeps the wire shape", async () => {
    const seen: Array<{ url: string; headers?: Record<string, string> }> = [];
    const fetchMock = mockFetch(async (input, init) => {
      seen.push({ url: String(input), headers: init?.headers as Record<string, string> | undefined });
      return Response.json({
        version: "0.6.143",
        publishedAt: "2026-10-09T20:20:20+02:00",
        files: [{ name: "my-claw-app-v0.6.143.apk", size: 46936461 }, { name: "dist-web.tar.gz", size: 1539691 }],
      });
    });
    try {
      expect(await latestAppUpdate()).toEqual({
        ok: true, version: "0.6.143", apkSize: 46936461, publishedAt: "2026-10-09T20:20:20+02:00",
      });
    } finally {
      fetchMock.restore();
    }
    expect(seen).toEqual([
      { url: `${HUB}/app/latest.json`, headers: { Accept: "application/json", Authorization: `Bearer ${KEY}` } },
    ]);
  });

  test("a latest release without its APK is no update, and a refused key says so", async () => {
    let answer: Response = Response.json({ version: "0.6.144", files: [{ name: "dist-web.tar.gz", size: 1 }] });
    const fetchMock = mockFetch(async () => answer);
    try {
      expect(await latestAppUpdate(true)).toEqual({ ok: false, error: "no app release found" });
      answer = new Response("a download key is needed", { status: 401 });
      expect(await latestAppUpdate(true)).toEqual({ ok: false, error: "release source answered HTTP 401" });
    } finally {
      fetchMock.restore();
    }
  });

  test("the APK is streamed from the hub's path, with the key", async () => {
    const seen: Array<{ url: string; headers?: Record<string, string> }> = [];
    const fetchMock = mockFetch(async (input, init) => {
      seen.push({ url: String(input), headers: init?.headers as Record<string, string> | undefined });
      return new Response("PK", { status: 200 });
    });
    try {
      const res = await streamAppApk({ ok: true, version: "0.6.143", apkSize: 2, publishedAt: "" });
      expect(res.status).toBe(200);
    } finally {
      fetchMock.restore();
    }
    expect(seen).toEqual([
      { url: `${HUB}/app/0.6.143/my-claw-app-v0.6.143.apk`, headers: { Authorization: `Bearer ${KEY}` } },
    ]);
  });
});
