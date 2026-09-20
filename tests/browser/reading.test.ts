import { test, describe } from "bun:test";
import assert from "node:assert";
import { BrowserClient } from "../../src/browser/client.ts";
import { createBrowserFetchTool, createBrowserTextTool } from "../../src/tools/browser/inspect.ts";
import { createBrowserReloadTool } from "../../src/tools/browser/navigation.ts";
import { createBrowserPageState, type BrowserPageState } from "../../src/tools/browser/state.ts";
import { mockFetch } from "../helpers/mock-fetch.ts";

interface Call {
  path: string;
  body: Record<string, unknown>;
}

function mockSidecar(
  answers: Record<string, unknown> = {},
  fail?: { path: string; status: number; error: string },
): { calls: Call[]; restore(): void } {
  const calls: Call[] = [];
  const handle = mockFetch(async (input, init) => {
    const url = String(input);
    const path = url.split("/").pop() ?? "";
    const body = JSON.parse(String((init as { body?: string }).body ?? "{}")) as Record<string, unknown>;
    const isFail = fail && fail.path === path;
    calls.push({ path, body });
    const payload = isFail ? { error: fail.error } : (answers[path] ?? {});
    return new Response(JSON.stringify(payload), { status: isFail ? fail.status : 200 }) as never;
  });
  return { calls, restore: handle.restore };
}

const SIDECAR = "http://127.0.0.1:9223";

function page(): { client: BrowserClient; state: BrowserPageState } {
  const client = new BrowserClient(SIDECAR);
  const state = createBrowserPageState();
  state.currentPageId = "p1";
  return { client, state };
}

describe("browser_fetch", () => {
  test("asks the site's API from the page and returns the body", async () => {
    const m = mockSidecar({
      fetch: { url: "https://site.test/api/x", status: 200, contentType: "application/json", truncated: false, body: '{"ok":true}' },
    });
    try {
      const { client, state } = page();
      const result = await createBrowserFetchTool(client, state).execute({ url: "/api/x" });
      assert.strictEqual(result.success, true);
      assert.match(result.output, /HTTP 200 application\/json/);
      assert.match(result.output, /\{"ok":true\}/);
      const sent = m.calls.find((c) => c.path === "fetch");
      assert.strictEqual(sent?.body.pageId, "p1");
      assert.strictEqual(sent?.body.url, "/api/x", "the page resolves a relative path, the tool does not");
    } finally {
      m.restore();
    }
  });

  test("a non-2xx status is a result, not an error", async () => {
    const m = mockSidecar({ fetch: { url: "https://s.test/x", status: 404, contentType: "text/plain", truncated: false, body: "not found" } });
    try {
      const { client, state } = page();
      const result = await createBrowserFetchTool(client, state).execute({ url: "https://s.test/x" });
      assert.strictEqual(result.success, true);
      assert.match(result.output, /HTTP 404/);
      assert.match(result.output, /not found/);
    } finally {
      m.restore();
    }
  });

  test("a truncated body says so, and an empty one says so", async () => {
    const m = mockSidecar({ fetch: { url: "u", status: 200, contentType: "", truncated: true, body: "x" } });
    try {
      const { client, state } = page();
      const truncated = await createBrowserFetchTool(client, state).execute({ url: "/a" });
      assert.match(truncated.output, /\[truncated\]/);
    } finally {
      m.restore();
    }
    const m2 = mockSidecar({ fetch: { url: "u", status: 204, contentType: "", truncated: false, body: "" } });
    try {
      const { client, state } = page();
      const empty = await createBrowserFetchTool(client, state).execute({ url: "/a" });
      assert.match(empty.output, /\(empty body\)/);
    } finally {
      m2.restore();
    }
  });

  test("method, headers and body are forwarded", async () => {
    const m = mockSidecar({ fetch: { url: "u", status: 200, contentType: "", truncated: false, body: "ok" } });
    try {
      const { client, state } = page();
      await createBrowserFetchTool(client, state).execute({ url: "/api", method: "POST", headers: { "content-type": "application/json", "x-drop": 7 }, body: "{}" });
      const sent = m.calls.find((c) => c.path === "fetch");
      assert.strictEqual(sent?.body.method, "POST");
      assert.strictEqual(sent?.body.body, "{}");
      assert.deepStrictEqual(sent?.body.headers, { "content-type": "application/json" }, "non-string header values are dropped");
    } finally {
      m.restore();
    }
  });

  test("an empty url is refused before reaching the sidecar", async () => {
    const m = mockSidecar({});
    try {
      const { client, state } = page();
      const result = await createBrowserFetchTool(client, state).execute({ url: "" });
      assert.strictEqual(result.success, false);
      assert.match(result.error ?? "", /needs a url/);
      assert.strictEqual(m.calls.length, 0);
    } finally {
      m.restore();
    }
  });

  test("a page-side request that fails surfaces the failure", async () => {
    const m = mockSidecar({}, { path: "fetch", status: 500, error: "Failed to fetch" });
    try {
      const { client, state } = page();
      const result = await createBrowserFetchTool(client, state).execute({ url: "https://other.test/x" });
      assert.strictEqual(result.success, false);
      assert.match(result.error ?? "", /Failed to fetch/);
    } finally {
      m.restore();
    }
  });
});

describe("browser_text", () => {
  test("returns the visible text", async () => {
    const m = mockSidecar({ text: { truncated: false, text: "Bonjour\ntout le monde" } });
    try {
      const { client, state } = page();
      const result = await createBrowserTextTool(client, state).execute({});
      assert.strictEqual(result.success, true);
      assert.match(result.output, /Bonjour/);
    } finally {
      m.restore();
    }
  });

  test("an empty page is not an error", async () => {
    const m = mockSidecar({ text: { truncated: false, text: "   " } });
    try {
      const { client, state } = page();
      const result = await createBrowserTextTool(client, state).execute({});
      assert.strictEqual(result.success, true);
      assert.match(result.output, /no visible text/);
    } finally {
      m.restore();
    }
  });

  test("max_chars is forwarded", async () => {
    const m = mockSidecar({ text: { truncated: false, text: "a" } });
    try {
      const { client, state } = page();
      await createBrowserTextTool(client, state).execute({ max_chars: 500 });
      assert.strictEqual(m.calls.find((c) => c.path === "text")?.body.maxChars, 500);
    } finally {
      m.restore();
    }
  });
});

describe("browser_reload", () => {
  test("returns a fresh snapshot", async () => {
    const m = mockSidecar({ reload: { url: "https://s.test/x", snapshot: { raw: 'button "Reload" [__ref="3"]', refs: [3] } } });
    try {
      const { client, state } = page();
      const result = await createBrowserReloadTool(client, state).execute({});
      assert.strictEqual(result.success, true);
      assert.match(result.output, /Interactive refs: 3/);
      assert.match(result.output, /Reload/);
    } finally {
      m.restore();
    }
  });

  test("a reload that fails surfaces the failure", async () => {
    const m = mockSidecar({}, { path: "reload", status: 500, error: "net::ERR_CONNECTION_RESET" });
    try {
      const { client, state } = page();
      const result = await createBrowserReloadTool(client, state).execute({});
      assert.strictEqual(result.success, false);
      assert.match(result.error ?? "", /ERR_CONNECTION_RESET/);
    } finally {
      m.restore();
    }
  });
});
