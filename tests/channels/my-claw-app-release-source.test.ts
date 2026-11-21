import { afterEach, describe, expect, test } from "bun:test";
import { appFileUrl, latestAppRelease } from "../../src/channels/my-claw-app/release-source.ts";
import { mockFetch } from "../helpers/mock-fetch.ts";

afterEach(() => {
  delete process.env["MY_CLAW_RELEASE_URL"];
  delete process.env["MY_CLAW_RELEASE_KEY"];
  delete process.env["MY_CLAW_APP_RELEASE_URL"];
});

const APP = "https://github.com/o/my-claw-app";

function github(answer: (url: string) => Response) {
  const seen: Array<{ url: string; method: string }> = [];
  const mock = mockFetch(async (input, init) => {
    const url = String(input);
    seen.push({ url, method: init?.method ?? "GET" });
    return answer(url);
  });
  return { seen, mock };
}

describe("the latest app release on GitHub", () => {
  test("is the tag, the APK size from HEAD, and whether a bundle rides along", async () => {
    process.env["MY_CLAW_RELEASE_URL"] = "https://github.com/o/my-claw";
    const { seen, mock } = github((url) => {
      if (url === `${APP}/releases/latest`) {
        return new Response(null, { status: 302, headers: { location: `${APP}/releases/tag/v0.6.240` } });
      }
      if (url.endsWith("/my-claw-app-v0.6.240.apk")) {
        return new Response(null, { status: 200, headers: { "content-length": "12345" } });
      }
      if (url.endsWith("/dist-web.tar.gz")) {
        return new Response(null, { status: 200, headers: { "content-length": "678" } });
      }
      return new Response("no", { status: 500 });
    });
    try {
      expect(await latestAppRelease()).toEqual({
        ok: true,
        release: { version: "0.6.240", apkSize: 12345, publishedAt: "", web: true },
      });
    } finally {
      mock.restore();
    }
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      `GET ${APP}/releases/latest`,
      `HEAD ${APP}/releases/download/v0.6.240/my-claw-app-v0.6.240.apk`,
      `HEAD ${APP}/releases/download/v0.6.240/dist-web.tar.gz`,
    ]);
  });

  test("an app-only release has no web bundle", async () => {
    process.env["MY_CLAW_RELEASE_URL"] = "https://github.com/o/my-claw";
    const mock = mockFetch(async (url) => {
      const target = String(url);
      if (target.endsWith("/releases/latest")) {
        return new Response(null, { status: 302, headers: { location: `${APP}/releases/tag/v0.6.241` } });
      }
      if (target.endsWith(".apk")) return new Response(null, { status: 200, headers: { "content-length": "9" } });
      return new Response("no", { status: 404 });
    });
    try {
      const result = await latestAppRelease();
      expect(result.ok && result.release.web).toBe(false);
    } finally {
      mock.restore();
    }
  });

  test("a tag without its APK is an error, not a release of size zero", async () => {
    process.env["MY_CLAW_RELEASE_URL"] = "https://github.com/o/my-claw";
    const mock = mockFetch(async (url) => {
      if (String(url).endsWith("/releases/latest")) {
        return new Response(null, { status: 302, headers: { location: `${APP}/releases/tag/v0.6.242` } });
      }
      return new Response("no", { status: 404 });
    });
    try {
      const result = await latestAppRelease();
      expect(result.ok).toBe(false);
      expect(!result.ok && result.error).toContain("has no my-claw-app-v0.6.242.apk");
    } finally {
      mock.restore();
    }
  });
});

describe("app asset URLs", () => {
  test("GitHub keeps the versioned asset names", () => {
    process.env["MY_CLAW_RELEASE_URL"] = "https://github.com/o/my-claw";
    expect(appFileUrl("v0.6.240", "apk")).toBe(`${APP}/releases/download/v0.6.240/my-claw-app-v0.6.240.apk`);
    expect(appFileUrl("0.6.240", "web")).toBe(`${APP}/releases/download/v0.6.240/dist-web.tar.gz`);
  });

  test("the layout keeps its component path", () => {
    process.env["MY_CLAW_RELEASE_URL"] = "https://dl.example.test/my-claw";
    expect(appFileUrl("v0.6.240", "web")).toBe("https://dl.example.test/my-claw/app/0.6.240/dist-web.tar.gz");
  });
});
