import { test, describe } from "bun:test";
import assert from "node:assert";
import { BrowserClient } from "../../src/browser/client.ts";
import { isBrowserInfraError } from "../../src/agent/subagents/browser.ts";
import { mockFetch } from "../helpers/mock-fetch.ts";

interface Call {
  path: string;
  body: Record<string, unknown>;
}

/** Mock the sidecar: record every call and answer per-endpoint. */
function mockSidecar(answers: Record<string, unknown>): { calls: Call[]; restore(): void } {
  const calls: Call[] = [];
  const handle = mockFetch(async (input, init) => {
    const url = String(input);
    const path = url.split("/").pop() ?? "";
    const body = JSON.parse(String((init as { body?: string }).body ?? "{}")) as Record<string, unknown>;
    calls.push({ path, body });
    const answer = answers[path] ?? {};
    return new Response(JSON.stringify(answer), { status: 200 }) as never;
  });
  return { calls, restore: handle.restore };
}

const SIDECAR = "http://127.0.0.1:9223";

describe("BrowserClient", () => {
  test("navigate creates a session first, then navigates", async () => {
    const m = mockSidecar({
      session: { sessionId: "s1" },
      navigate: { pageId: "p1", snapshot: { raw: 'btn [__ref="5"]', refs: [5] }, url: "https://example.com" },
    });
    try {
      const client = new BrowserClient(SIDECAR);
      const result = await client.navigate("https://example.com");
      assert.strictEqual(result.pageId, "p1");
      assert.strictEqual(result.url, "https://example.com");
      assert.deepStrictEqual(result.snapshot.refs, [5]);
      assert.strictEqual(m.calls[0]?.path, "session");
      assert.strictEqual(m.calls[1]?.path, "navigate");
      assert.strictEqual(m.calls[1]?.body.sessionId, "s1");
      assert.strictEqual(m.calls[1]?.body.url, "https://example.com");
    } finally {
      m.restore();
    }
  });

  test("the session is created once and reused across calls", async () => {
    const m = mockSidecar({
      session: { sessionId: "s1" },
      navigate: { pageId: "p1", snapshot: { raw: "", refs: [] }, url: "https://a.test" },
      snapshot: { raw: "", refs: [] },
    });
    try {
      const client = new BrowserClient(SIDECAR);
      await client.navigate("https://a.test");
      await client.snapshot("p1");
      await client.navigate("https://b.test");
      const sessionCalls = m.calls.filter((c) => c.path === "session");
      assert.strictEqual(sessionCalls.length, 1, "session must be created exactly once");
    } finally {
      m.restore();
    }
  });

  test("click and type pass pageId, ref and text", async () => {
    const m = mockSidecar({ session: { sessionId: "s1" }, click: {}, type: {} });
    try {
      const client = new BrowserClient(SIDECAR);
      await client.click("p9", 5);
      await client.type("p9", 3, "hello");
      const click = m.calls.find((c) => c.path === "click");
      const type = m.calls.find((c) => c.path === "type");
      assert.deepStrictEqual({ pageId: click?.body.pageId, ref: click?.body.ref }, { pageId: "p9", ref: 5 });
      assert.deepStrictEqual(
        { pageId: type?.body.pageId, ref: type?.body.ref, text: type?.body.text },
        { pageId: "p9", ref: 3, text: "hello" },
      );
    } finally {
      m.restore();
    }
  });

  test("screenshot returns an image attachment", async () => {
    const m = mockSidecar({ screenshot: { type: "image", path: "/tmp/browser-x.png", mimeType: "image/png" } });
    try {
      const client = new BrowserClient(SIDECAR);
      const att = await client.screenshot("p1", true);
      assert.strictEqual(att.type, "image");
      assert.strictEqual(att.mimeType, "image/png");
      assert.strictEqual(m.calls[0]?.body.fullPage, true);
    } finally {
      m.restore();
    }
  });

  test("screenshotWithLabels sets labels=true on the same endpoint", async () => {
    const m = mockSidecar({ screenshot: { type: "image", path: "/tmp/browser-y.png", mimeType: "image/png" } });
    try {
      const client = new BrowserClient(SIDECAR);
      await client.screenshotWithLabels("p1", false);
      assert.strictEqual(m.calls[0]?.path, "screenshot");
      assert.strictEqual(m.calls[0]?.body.labels, true);
    } finally {
      m.restore();
    }
  });

  test("listTabs, focusTab and closeTab carry the sessionId", async () => {
    const m = mockSidecar({
      session: { sessionId: "s1" },
      tabs: { tabs: [{ id: "0", url: "https://a.test", title: "" }] },
      "focus-tab": { pageId: "p2", url: "https://a.test" },
      "close-tab": {},
    });
    try {
      const client = new BrowserClient(SIDECAR);
      const tabs = await client.listTabs();
      assert.strictEqual(tabs.length, 1);
      const pageId = await client.focusTab(0);
      assert.strictEqual(pageId, "p2");
      await client.closeTab(0);
      assert.strictEqual(m.calls.find((c) => c.path === "focus-tab")?.body.sessionId, "s1");
      assert.strictEqual(m.calls.find((c) => c.path === "close-tab")?.body.index, 0);
    } finally {
      m.restore();
    }
  });

  test("cleanup posts the sessionId once a session exists", async () => {
    const m = mockSidecar({
      session: { sessionId: "s1" },
      navigate: { pageId: "p1", snapshot: { raw: "", refs: [] }, url: "https://a.test" },
      cleanup: {},
    });
    try {
      const client = new BrowserClient(SIDECAR);
      await client.navigate("https://a.test");
      await client.cleanup();
      const cleanup = m.calls.find((c) => c.path === "cleanup");
      assert.strictEqual(cleanup?.body.sessionId, "s1");
    } finally {
      m.restore();
    }
  });

  test("cleanup is a no-op when no session was created", async () => {
    const m = mockSidecar({ cleanup: {} });
    try {
      const client = new BrowserClient(SIDECAR);
      await client.cleanup();
      assert.strictEqual(m.calls.length, 0, "cleanup must not hit the sidecar if no session exists");
    } finally {
      m.restore();
    }
  });

  test("an unreachable sidecar throws an infra-classified error", async () => {
    const handle = mockFetch(async () => {
      throw new Error("Unable to connect. ECONNREFUSED 127.0.0.1:9223");
    });
    try {
      const client = new BrowserClient(SIDECAR);
      let caught: string | undefined;
      try {
        await client.navigate("https://a.test");
      } catch (e) {
        caught = String(e);
      }
      assert.ok(caught?.includes("sidecar unreachable"), "error should name the sidecar");
      assert.ok(isBrowserInfraError(caught), "an unreachable sidecar must be classified as infra (no human handoff)");
    } finally {
      handle.restore();
    }
  });

  test("a call that outruns its budget says so, instead of reporting a browser that never died", async () => {
    const handle = mockFetch(async () => {
      // What fetch really throws on AbortSignal.timeout: same rejection path as a refused
      // connection, which is how a slow call used to be reported as a crashed sidecar.
      const e = new Error("The operation was aborted due to timeout");
      e.name = "TimeoutError";
      throw e;
    });
    try {
      const client = new BrowserClient(SIDECAR);
      let caught: string | undefined;
      try {
        await client.navigate("https://slow.test");
      } catch (e) {
        caught = String(e);
      }
      assert.ok(caught?.includes("budget"), `a timeout must be named as one, got: ${caught}`);
      assert.ok(!caught?.includes("unreachable"), "a timeout is not an unreachable sidecar");
      assert.ok(
        !isBrowserInfraError(caught),
        "a timeout must not be classified as infra: it triggers the browser-is-down handoff",
      );
    } finally {
      handle.restore();
    }
  });

  test("the reading endpoints are addressed by page, and a response body by the id its listing gave", async () => {
    const m = mockSidecar({
      session: { sessionId: "s1" },
      navigate: { pageId: "p1", snapshot: { raw: "", refs: [] }, url: "https://a.test" },
      find: { query: "q", matches: 1, lines: ["row"], url: "https://a.test" },
      responses: { total: 3, responses: [{ id: 2, url: "https://a.test/api", status: 200, type: "application/json", method: "GET" }] },
      responseBody: { url: "https://a.test/api", status: 200, truncated: false, body: "{}" },
    });
    try {
      const client = new BrowserClient(SIDECAR);
      await client.navigate("https://a.test");
      await client.find("p1", "needle");
      await client.responses("p1", "api");
      await client.responseBody("p1", 2);
      const find = m.calls.find((c) => c.path === "find");
      assert.deepStrictEqual(find?.body, { pageId: "p1", query: "needle" });
      const list = m.calls.find((c) => c.path === "responses");
      assert.deepStrictEqual(list?.body, { pageId: "p1", filter: "api" });
      const read = m.calls.find((c) => c.path === "responseBody");
      assert.deepStrictEqual(read?.body, { pageId: "p1", responseId: 2 });
    } finally {
      m.restore();
    }
  });

  test("a sidecar error body surfaces the server message (and stays non-infra for page timeouts)", async () => {
    const handle = mockFetch(async (input) => {
      const path = String(input).split("/").pop();
      if (path === "session") return new Response(JSON.stringify({ sessionId: "s1" }), { status: 200 }) as never;
      return new Response(JSON.stringify({ error: "page.goto: Timeout 30000ms exceeded" }), { status: 500 }) as never;
    });
    try {
      const client = new BrowserClient(SIDECAR);
      let caught: string | undefined;
      try {
        await client.navigate("https://slow.test");
      } catch (e) {
        caught = String(e);
      }
      assert.ok(caught?.includes("Timeout 30000ms exceeded"), "server error message should surface");
      assert.ok(!isBrowserInfraError(caught), "a page timeout is a normal failure, not an infra outage");
    } finally {
      handle.restore();
    }
  });

  test("uploadFile posts the paths and leaves ref undefined when omitted", async () => {
    const m = mockSidecar({ upload: { via: "page-input", fileInputs: 2 } });
    try {
      const client = new BrowserClient(SIDECAR);
      const info = await client.uploadFile("p1", ["/ws/claw.png"]);
      assert.strictEqual(info.via, "page-input");
      assert.strictEqual(info.fileInputs, 2);
      assert.strictEqual(m.calls[0]?.path, "upload");
      assert.deepStrictEqual(m.calls[0]?.body.paths, ["/ws/claw.png"]);
      assert.strictEqual(m.calls[0]?.body.ref, undefined);
    } finally {
      m.restore();
    }
  });

  test("selectOption targets the select-option endpoint with ref and value", async () => {
    const m = mockSidecar({ "select-option": { via: "role=option" } });
    try {
      const client = new BrowserClient(SIDECAR);
      const info = await client.selectOption("p1", 7, "July");
      assert.strictEqual(info.via, "role=option");
      assert.strictEqual(m.calls[0]?.path, "select-option");
      assert.strictEqual(m.calls[0]?.body.ref, 7);
      assert.strictEqual(m.calls[0]?.body.value, "July");
    } finally {
      m.restore();
    }
  });

  test("pressKey and scroll hit their endpoints with the expected payloads", async () => {
    const m = mockSidecar({ "press-key": {}, scroll: {} });
    try {
      const client = new BrowserClient(SIDECAR);
      await client.pressKey("p1", "Enter");
      await client.scroll("p1", "down", 900);
      assert.strictEqual(m.calls[0]?.path, "press-key");
      assert.strictEqual(m.calls[0]?.body.key, "Enter");
      assert.strictEqual(m.calls[1]?.path, "scroll");
      assert.strictEqual(m.calls[1]?.body.direction, "down");
      assert.strictEqual(m.calls[1]?.body.amount, 900);
    } finally {
      m.restore();
    }
  });

  test("the P1/P2 endpoints are addressed with the expected payloads", async () => {
    const m = mockSidecar({
      "click-at": { x: 10, y: 20, viewport: { width: 100, height: 200 } },
      "wait-for": { waited: "text" },
      hover: {},
      drag: {},
      evaluate: { value: '"t"' },
      cdp: { result: "{}" },
      "handle-dialog": {},
      "download-wait": { path: "/d/f.pdf", filename: "f.pdf" },
      pdf: { path: "/d/p.pdf" },
    });
    try {
      const client = new BrowserClient(SIDECAR);
      const at = await client.clickAt("p1", 0.25, 0.75);
      assert.deepStrictEqual(at.viewport, { width: 100, height: 200 });
      await client.waitFor("p1", { text: "Loaded", timeoutMs: 4000 });
      await client.hover("p1", 2);
      await client.drag("p1", 3, 4);
      await client.evaluate("p1", "return 1");
      await client.cdp("p1", "DOM.getDocument", { depth: 1 });
      await client.handleDialog("p1", false, "typed");
      const dl = await client.waitForDownload("p1", "/d", 1000);
      assert.strictEqual(dl.filename, "f.pdf");
      await client.pdf("p1", "/d/p.pdf");

      const byPath = new Map(m.calls.map((c) => [c.path, c.body]));
      assert.deepStrictEqual(byPath.get("click-at"), { pageId: "p1", x: 0.25, y: 0.75 });
      assert.deepStrictEqual(byPath.get("wait-for"), { pageId: "p1", text: "Loaded", timeoutMs: 4000 });
      assert.deepStrictEqual(byPath.get("drag"), { pageId: "p1", fromRef: 3, toRef: 4 });
      assert.deepStrictEqual(byPath.get("cdp"), { pageId: "p1", method: "DOM.getDocument", params: { depth: 1 } });
      assert.deepStrictEqual(byPath.get("handle-dialog"), { pageId: "p1", accept: false, promptText: "typed" });
      assert.deepStrictEqual(byPath.get("download-wait"), { pageId: "p1", dir: "/d", timeoutMs: 1000 });
    } finally {
      m.restore();
    }
  });

  test("a per-endpoint timeout aborts the call", async () => {
    // The mock honours the abort signal, so this checks the real deadline the client sets
    // rather than just the presence of a signal.
    const handle = mockFetch(async (_input, init) => {
      const signal = (init as { signal?: AbortSignal }).signal;
      return await new Promise<never>((resolve, reject) => {
        const timer = setTimeout(() => resolve(new Response("{}", { status: 200 }) as never), 2000);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Error("TimeoutError: signal timed out"));
        });
      });
    });
    try {
      const client = new BrowserClient(SIDECAR, undefined, { default: 40 });
      await assert.rejects(client.snapshot("p1"), /unreachable|timed out/i);
    } finally {
      handle.restore();
    }
  });

  test("an endpoint-specific timeout overrides the default", async () => {
    const seen: number[] = [];
    const handle = mockFetch(async (input, init) => {
      const signal = (init as { signal?: AbortSignal }).signal;
      const path = String(input).split("/").pop() ?? "";
      const started = Date.now();
      return await new Promise<never>((resolve, reject) => {
        const timer = setTimeout(() => {
          seen.push(Date.now() - started);
          resolve(new Response(JSON.stringify({ waited: "delay" }), { status: 200 }) as never);
        }, 120);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Error(`aborted ${path}`));
        });
      });
    });
    try {
      // snapshot uses the short default and must abort; wait-for has room and must succeed.
      const client = new BrowserClient(SIDECAR, undefined, { default: 40, "wait-for": 600 });
      await assert.rejects(client.snapshot("p1"), /unreachable|aborted/i);
      const result = await client.waitFor("p1", { timeoutMs: 10 });
      assert.strictEqual(result.waited, "delay");
      assert.ok(seen.length === 1, "only the long-timeout call should have completed");
    } finally {
      handle.restore();
    }
  });
});
