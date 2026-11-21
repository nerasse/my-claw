import { afterEach, describe, expect, test } from "bun:test";
import {
  authHeaders,
  githubLatestVersion,
  nodeAssetUrl,
  releaseSource,
  serverTarballUrl,
} from "../../src/core/release-source.ts";
import { mockFetch } from "../helpers/mock-fetch.ts";

afterEach(() => {
  delete process.env["MY_CLAW_RELEASE_URL"];
  delete process.env["MY_CLAW_RELEASE_KEY"];
  delete process.env["MY_CLAW_APP_RELEASE_URL"];
});

describe("the source", () => {
  test("a GitHub repository implies its app sibling", () => {
    process.env["MY_CLAW_RELEASE_URL"] = "https://github.com/o/my-claw/";
    expect(releaseSource()).toEqual({
      kind: "github",
      server: "https://github.com/o/my-claw",
      app: "https://github.com/o/my-claw-app",
    });
  });

  test("the app repository can be somewhere else", () => {
    process.env["MY_CLAW_RELEASE_URL"] = "https://github.com/o/my-claw";
    process.env["MY_CLAW_APP_RELEASE_URL"] = "https://github.com/other/app/";
    expect(releaseSource()?.app).toBe("https://github.com/other/app");
  });

  test("the old hub URL means the GitHub repository, key and all", () => {
    process.env["MY_CLAW_RELEASE_URL"] = "https://dl.kssimi.fr/my-claw";
    process.env["MY_CLAW_RELEASE_KEY"] = "dlh_old";
    expect(releaseSource()).toEqual({
      kind: "github",
      server: "https://github.com/nerasse/my-claw",
      app: "https://github.com/nerasse/my-claw-app",
    });
  });

  test("anything else is the neutral layout, key included", () => {
    process.env["MY_CLAW_RELEASE_URL"] = "https://dl.example.test/my-claw/";
    process.env["MY_CLAW_RELEASE_KEY"] = "dlh_k";
    expect(releaseSource()).toEqual({
      kind: "layout",
      server: "https://dl.example.test/my-claw",
      app: "https://dl.example.test/my-claw",
      key: "dlh_k",
    });
  });
});

describe("asset URLs", () => {
  test("GitHub release assets", () => {
    process.env["MY_CLAW_RELEASE_URL"] = "https://github.com/o/my-claw";
    expect(serverTarballUrl("v0.7.201")).toBe(
      "https://github.com/o/my-claw/releases/download/v0.7.201/my-claw-0.7.201-linux-x64.tar.gz",
    );
    expect(nodeAssetUrl("0.7.201", "my-claw-node-0.7.201-linux-x64")).toBe(
      "https://github.com/o/my-claw/releases/download/v0.7.201/my-claw-node-0.7.201-linux-x64",
    );
  });

  test("the neutral layout keeps its component paths", () => {
    process.env["MY_CLAW_RELEASE_URL"] = "https://dl.example.test/my-claw";
    expect(serverTarballUrl("0.7.201")).toBe(
      "https://dl.example.test/my-claw/server/0.7.201/my-claw-0.7.201-linux-x64.tar.gz",
    );
    expect(nodeAssetUrl("0.7.201", "my-claw-node-0.7.201-linux-x64")).toBe(
      "https://dl.example.test/my-claw/node/0.7.201/my-claw-node-0.7.201-linux-x64",
    );
  });
});

describe("the key", () => {
  test("never travels to GitHub, even when one is still in .env", () => {
    process.env["MY_CLAW_RELEASE_URL"] = "https://github.com/o/my-claw";
    process.env["MY_CLAW_RELEASE_KEY"] = "dlh_old";
    expect(authHeaders("https://github.com/o/my-claw/releases/download/v1/x.tar.gz")).toEqual({});
  });

  test("still travels to the layout it belongs to", () => {
    process.env["MY_CLAW_RELEASE_URL"] = "https://dl.example.test/my-claw";
    process.env["MY_CLAW_RELEASE_KEY"] = "dlh_k";
    expect(authHeaders("https://dl.example.test/my-claw/server/1/x.tar.gz")).toEqual({ Authorization: "Bearer dlh_k" });
    expect(authHeaders("https://mirror.example.test/x.tar.gz")).toEqual({});
  });
});

describe("the GitHub redirect", () => {
  test("names the newest tag", async () => {
    const mock = mockFetch(
      async () => new Response(null, { status: 302, headers: { location: "https://github.com/o/r/releases/tag/v1.2.3" } }),
    );
    try {
      expect(await githubLatestVersion("https://github.com/o/r")).toBe("1.2.3");
    } finally {
      mock.restore();
    }
  });

  test("a repository without a release has no version", async () => {
    for (const answer of [new Response("", { status: 200 }), new Response("no", { status: 404 })]) {
      const mock = mockFetch(async () => answer);
      try {
        expect(await githubLatestVersion("https://github.com/o/r")).toBeUndefined();
      } finally {
        mock.restore();
      }
    }
  });
});
