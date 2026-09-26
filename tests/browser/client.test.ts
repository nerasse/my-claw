import { test, describe } from "bun:test";
import assert from "node:assert";
import { BrowserClient } from "../../src/browser/client.ts";
import { isBrowserInfraError } from "../../src/tools/browser/session.ts";
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
  test("navigate posts the url with the tab to reuse and its window, and opens no session", async () => {
    const m = mockSidecar({
      navigate: { pageId: "p1", snapshot: { raw: 'btn [__ref="5"]', refs: [5] }, url: "https://example.com" },
    });
    try {
      const client = new BrowserClient(SIDECAR);
      const result = await client.navigate("https://example.com", { pageId: "p1", windowId: 7 });
      assert.strictEqual(result.pageId, "p1");
      assert.deepStrictEqual(result.snapshot.refs, [5]);
      assert.deepStrictEqual(m.calls.map((c) => c.path), ["navigate"]);
      assert.strictEqual(m.calls[0]?.body.url, "https://example.com");
      assert.strictEqual(m.calls[0]?.body.pageId, "p1");
      assert.strictEqual(m.calls[0]?.body.windowId, 7);
    } finally {
      m.restore();
    }
  });

  test("a new tab is asked for in a window", async () => {
    const m = mockSidecar({ navigate: { pageId: "p9", snapshot: { raw: "", refs: [] }, url: "https://a.test" } });
    try {
      await new BrowserClient(SIDECAR).navigate("https://a.test", { windowId: 3, newTab: true });
      assert.strictEqual(m.calls[0]?.body.windowId, 3);
      assert.strictEqual(m.calls[0]?.body.newTab, true);
      assert.strictEqual(m.calls[0]?.body.pageId, undefined);
    } finally {
      m.restore();
    }
  });

  test("windows are listed, created with the viewport, and closed by id", async () => {
    const m = mockSidecar({
      "list-windows": { windows: [{ windowId: 5, tabs: [{ pageId: "p1", url: "https://a.test", title: "A" }] }] },
      "create-window": { windowId: 6, pageId: "p2", snapshot: { raw: "", refs: [] }, url: "https://b.test" },
      "close-window": {},
    });
    try {
      const client = new BrowserClient(SIDECAR, { width: 1280, height: 800 });
      const windows = await client.listWindows();
      assert.strictEqual(windows[0]?.tabs[0]?.pageId, "p1");
      const created = await client.createWindow("https://b.test");
      assert.strictEqual(created.windowId, 6);
      await client.closeWindow(6);
      assert.deepStrictEqual(m.calls.find((c) => c.path === "create-window")?.body, { url: "https://b.test", viewport: { width: 1280, height: 800 } });
      assert.strictEqual(m.calls.find((c) => c.path === "close-window")?.body.windowId, 6);
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

  test("listTabs, focusTab and closeTab name tabs by their page", async () => {
    const m = mockSidecar({
      tabs: { tabs: [{ id: "p1", url: "https://a.test", title: "" }] },
      "focus-tab": { pageId: "p2", url: "https://a.test" },
      "close-tab": {},
    });
    try {
      const client = new BrowserClient(SIDECAR);
      const tabs = await client.listTabs();
      assert.strictEqual(tabs.length, 1);
      await client.focusTab("p2");
      await client.closeTab("p3");
      assert.strictEqual(m.calls.find((c) => c.path === "focus-tab")?.body.pageId, "p2");
      assert.strictEqual(m.calls.find((c) => c.path === "close-tab")?.body.pageId, "p3");
      assert.ok(m.calls.every((c) => !("sessionId" in c.body)), "there is no sidecar session any more");
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
      responseBody: { url: "https://a.test/api", status: 200, body: "{}" },
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

/**
 * A tab stuck in its own JavaScript answers nothing, and whatever waited on it waited for every run
 * (2026-09-26: the window listing timed out 80 times over forty minutes, and runs on other sites
 * failed with it). The client tells a frozen page from a slow one and closes the frozen one, unless
 * a human was handed its window.
 */
describe("BrowserClient: a frozen tab", () => {
  const timeout = (): never => {
    const e = new Error("The operation was aborted due to timeout");
    e.name = "TimeoutError";
    throw e;
  };

  function sidecar(answer: (path: string, body: Record<string, unknown>) => Response | Promise<Response>) {
    const calls: Call[] = [];
    const handle = mockFetch(async (input, init) => {
      const path = String(input).split("/").pop() ?? "";
      const body = JSON.parse(String((init as { body?: string }).body ?? "{}")) as Record<string, unknown>;
      calls.push({ path, body });
      return (await answer(path, body)) as never;
    });
    return { calls, restore: handle.restore };
  }

  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

  const failure = async (call: Promise<unknown>): Promise<string> => {
    try {
      await call;
    } catch (e) {
      return (e as Error).message;
    }
    throw new Error("the call was expected to fail");
  };

  test("a call that runs out of time on a frozen page closes the tab and says so", async () => {
    const m = sidecar((path) => {
      if (path === "probe") return json({ open: true, responsive: false, url: "https://careers.test/job" });
      if (path === "close-target") return json({});
      return timeout();
    });
    try {
      const error = await failure(new BrowserClient(SIDECAR).snapshot("p1"));
      assert.match(error, /frozen/);
      assert.match(error, /was closed/);
      assert.match(error, /https:\/\/careers\.test\/job/);
      assert.ok(!isBrowserInfraError(error), "a frozen tab is not the browser being down");
      assert.deepStrictEqual(m.calls.map((c) => c.path), ["snapshot", "probe", "close-target"]);
      assert.deepStrictEqual(m.calls[2]?.body, { pageId: "p1" });
    } finally {
      m.restore();
    }
  });

  // Owner, 2026-09-26: never close a tab an agent is waiting on the user for.
  test("a frozen tab a human was handed is left open", async () => {
    const m = sidecar((path) => {
      if (path === "probe") return json({ open: true, responsive: false, url: "https://captcha.test" });
      if (path === "close-target") return json({});
      return timeout();
    });
    try {
      const client = new BrowserClient(SIDECAR);
      client.keepOpenWhen((pageId) => pageId === "p1");
      const error = await failure(client.snapshot("p1"));
      assert.match(error, /frozen/);
      assert.match(error, /left open/);
      assert.ok(!m.calls.some((c) => c.path === "close-target"), "the human's tab must not be closed");
    } finally {
      m.restore();
    }
  });

  test("a page that is only slow is left alone, and said to be slow", async () => {
    const m = sidecar((path) => (path === "probe" ? json({ open: true, responsive: true, url: "https://slow.test" }) : timeout()));
    try {
      const error = await failure(new BrowserClient(SIDECAR).text("p1"));
      assert.match(error, /slow, not stuck/);
      assert.ok(!error.includes("raise the budget"), "the agent has no budget to raise");
      assert.ok(!m.calls.some((c) => c.path === "close-target"));
    } finally {
      m.restore();
    }
  });

  test("Playwright's own timeout on a live page keeps its message: it says what it waited for", async () => {
    const message = "locator.waitFor: Timeout 30000ms exceeded. waiting for getByText('First name')";
    const m = sidecar((path) => (path === "probe" ? json({ open: true, responsive: true }) : json({ error: message }, 500)));
    try {
      const error = await failure(new BrowserClient(SIDECAR).waitFor("p1", { text: "First name" }));
      assert.strictEqual(error, message);
      assert.deepStrictEqual(m.calls.map((c) => c.path), ["wait-for", "probe"]);
    } finally {
      m.restore();
    }
  });

  test("Playwright's timeout on a frozen page closes it too", async () => {
    const m = sidecar((path) => {
      if (path === "probe") return json({ open: true, responsive: false, url: "https://careers.test" });
      if (path === "close-target") return json({});
      return json({ error: "page.goto: Timeout 30000ms exceeded." }, 500);
    });
    try {
      const error = await failure(new BrowserClient(SIDECAR).navigate("https://careers.test", { pageId: "p1" }));
      assert.match(error, /frozen/);
      assert.ok(m.calls.some((c) => c.path === "close-target"));
    } finally {
      m.restore();
    }
  });

  test("a browser the sidecar cannot reach for a frozen tab gets the tab closed, and the call goes through", async () => {
    let attempts = 0;
    const m = sidecar((path) => {
      if (path === "close-target") return json({});
      attempts += 1;
      if (attempts === 1) {
        return json({ error: "The browser cannot be reached while 1 of its tabs is frozen", frozen: [{ pageId: "f1", url: "https://stuck.test" }] }, 500);
      }
      return json({ windows: [] });
    });
    try {
      assert.deepStrictEqual(await new BrowserClient(SIDECAR).listWindows(), []);
      assert.deepStrictEqual(m.calls.map((c) => c.path), ["list-windows", "close-target", "list-windows"]);
      assert.deepStrictEqual(m.calls[1]?.body, { pageId: "f1" });
    } finally {
      m.restore();
    }
  });

  test("the frozen tab holding the browser is kept when a human was handed it, and the caller is told", async () => {
    const m = sidecar((path) =>
      path === "close-target"
        ? json({})
        : json({ error: "The browser cannot be reached while 1 of its tabs is frozen", frozen: [{ pageId: "h1", url: "https://captcha.test" }] }, 500),
    );
    try {
      const client = new BrowserClient(SIDECAR);
      client.keepOpenWhen((pageId) => pageId === "h1");
      const error = await failure(client.listWindows());
      assert.match(error, /human/);
      assert.ok(!m.calls.some((c) => c.path === "close-target"));
      assert.ok(!isBrowserInfraError(error));
    } finally {
      m.restore();
    }
  });

  test("a call on no page is never probed", async () => {
    const m = sidecar(() => timeout());
    try {
      const error = await failure(new BrowserClient(SIDECAR).listWindows());
      assert.match(error, /budget/);
      assert.deepStrictEqual(m.calls.map((c) => c.path), ["list-windows"]);
    } finally {
      m.restore();
    }
  });

  test("a call that asks the sidecar to wait is given that long", async () => {
    const handle = mockFetch(async (_input, init) => {
      const signal = (init as { signal?: AbortSignal }).signal;
      return await new Promise<never>((resolve, reject) => {
        const timer = setTimeout(() => resolve(json({ waited: "delay" }) as never), 150);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(Object.assign(new Error("aborted"), { name: "TimeoutError" }));
        });
      });
    });
    const m = { restore: handle.restore };
    try {
      const client = new BrowserClient(SIDECAR, undefined, { default: 40, "wait-for": 40 });
      const result = await client.waitFor("p1", { timeoutMs: 100 });
      assert.strictEqual(result.waited, "delay");
    } finally {
      m.restore();
    }
  });
});
