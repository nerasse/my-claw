import { test, describe } from "bun:test";
import assert from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createBrowserNavigateTool,
  createBrowserSnapshotTool,
  createBrowserClickTool,
  createBrowserTypeTool,
  createBrowserSelectOptionTool,
  createBrowserUploadFileTool,
  createBrowserPressKeyTool,
  createBrowserScrollTool,
  createBrowserHoverTool,
  createBrowserDragTool,
  createBrowserClickAtTool,
  createBrowserWaitForTool,
  createBrowserEvalTool,
  createBrowserCdpTool,
  createBrowserHandleDialogTool,
  createBrowserDownloadTool,
  createBrowserPdfTool,
  isCdpMethodAllowed,
  createBrowserScreenshotTool,
  createBrowserListTabsTool,
  createBrowserFocusTabTool,
  createBrowserCloseTabTool,
  createBrowserPageState,
  enqueueBrowserTask,
} from "../../src/tools/browser/index.ts";
import type { BrowserClient } from "../../src/browser/client.ts";
import { createMock } from "../helpers/mock.ts";

function createMockClient(): BrowserClient {
  const snapshot = { raw: 'button "OK" [__ref="5"]', refs: [5] };
  return {
    navigate: createMock(() => Promise.resolve({ pageId: "p1", snapshot, url: "https://example.com" })),
    snapshot: createMock(() => Promise.resolve(snapshot)),
    click: createMock(() => Promise.resolve()),
    type: createMock(() => Promise.resolve()),
    uploadFile: createMock(() => Promise.resolve({ via: "page-input" })),
    hover: createMock(() => Promise.resolve()),
    drag: createMock(() => Promise.resolve()),
    clickAt: createMock(() => Promise.resolve({ x: 960, y: 540, viewport: { width: 1920, height: 1080 } })),
    waitFor: createMock(() => Promise.resolve({ waited: "text" })),
    evaluate: createMock(() => Promise.resolve({ value: '"Example"' })),
    cdp: createMock(() => Promise.resolve({ result: '{"root":{}}' })),
    handleDialog: createMock(() => Promise.resolve()),
    waitForDownload: createMock(() => Promise.resolve({ path: "/ws/downloads/f.pdf", filename: "f.pdf" })),
    pdf: createMock((_p: string, path: string) => Promise.resolve({ path })),
    selectOption: createMock(() => Promise.resolve({ via: "role=option" })),
    pressKey: createMock(() => Promise.resolve()),
    scroll: createMock(() => Promise.resolve()),
    screenshot: createMock(() => Promise.resolve({ type: "image", path: "/tmp/test.png", mimeType: "image/png" })),
    screenshotWithLabels: createMock(() => Promise.resolve({ type: "image", path: "/tmp/test.png", mimeType: "image/png" })),
    listTabs: createMock(() => Promise.resolve([{ id: "0", url: "https://example.com", title: "" }])),
    focusTab: createMock(() => Promise.resolve("p1")),
    closeTab: createMock(() => Promise.resolve()),
    cleanup: createMock(() => Promise.resolve()),
  } as unknown as BrowserClient;
}

describe("browser tools", () => {
  test("navigate rejects localhost", async () => {
    const tool = createBrowserNavigateTool(createMockClient(), createBrowserPageState());
    const result = await tool.execute({ url: "http://localhost:8080" });
    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes("blocked"));
  });

  test("navigate rejects file protocol", async () => {
    const tool = createBrowserNavigateTool(createMockClient(), createBrowserPageState());
    const result = await tool.execute({ url: "file:///etc/passwd" });
    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes("blocked"));
  });

  test("navigate succeeds with valid url and sets the current page", async () => {
    const state = createBrowserPageState();
    const tool = createBrowserNavigateTool(createMockClient(), state);
    const result = await tool.execute({ url: "https://example.com" });
    assert.strictEqual(result.success, true);
    assert.ok(result.output.includes("OK"));
    assert.strictEqual(state.currentPageId, "p1");
  });

  test("snapshot requires active page", async () => {
    const tool = createBrowserSnapshotTool(createMockClient(), createBrowserPageState());
    const result = await tool.execute({});
    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes("No active browser page"));
  });

  test("click requires active page", async () => {
    const tool = createBrowserClickTool(createMockClient(), createBrowserPageState());
    const result = await tool.execute({ ref: 5 });
    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes("No active browser page"));
  });

  test("type requires active page", async () => {
    const tool = createBrowserTypeTool(createMockClient(), createBrowserPageState());
    const result = await tool.execute({ ref: 3, text: "hello" });
    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes("No active browser page"));
  });

  test("click uses the current page id", async () => {
    const client = createMockClient();
    const state = createBrowserPageState();
    state.currentPageId = "p7";
    const tool = createBrowserClickTool(client, state);
    const result = await tool.execute({ ref: 5 });
    assert.strictEqual(result.success, true);
    assert.strictEqual((client.click as unknown as { calls: { arguments: unknown[] }[] }).calls[0]?.arguments[0], "p7");
  });

  test("screenshot returns attachment", async () => {
    const state = createBrowserPageState();
    state.currentPageId = "p1";
    const tool = createBrowserScreenshotTool(createMockClient(), state);
    const result = await tool.execute({ full_page: true });
    assert.strictEqual(result.success, true);
    assert.ok(result.attachments);
    assert.strictEqual(result.attachments![0]!.type, "image");
  });

  test("list_tabs returns tab list", async () => {
    const tool = createBrowserListTabsTool(createMockClient());
    const result = await tool.execute({});
    assert.strictEqual(result.success, true);
  });

  test("focus_tab switches to tab and updates the state", async () => {
    const state = createBrowserPageState();
    const tool = createBrowserFocusTabTool(createMockClient(), state);
    const result = await tool.execute({ index: 0 });
    assert.strictEqual(result.success, true);
    assert.strictEqual(state.currentPageId, "p1");
  });

  test("close_tab closes tab", async () => {
    const tool = createBrowserCloseTabTool(createMockClient());
    const result = await tool.execute({ index: 0 });
    assert.strictEqual(result.success, true);
    assert.ok(result.output.includes("closed"));
  });

  test("two subagents' page states are isolated (no cross-clobbering)", async () => {
    const clientA = createMockClient();
    const stateA = createBrowserPageState();
    const stateB = createBrowserPageState();

    const navigateA = createBrowserNavigateTool(clientA, stateA);
    await navigateA.execute({ url: "https://example.com" });
    assert.strictEqual(stateA.currentPageId, "p1");

    // B has its own state: A's navigation must not leak into B's tools.
    const clickB = createBrowserClickTool(createMockClient(), stateB);
    const result = await clickB.execute({ ref: 5 });
    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes("No active browser page"));
    assert.strictEqual(stateB.currentPageId, null);
    assert.strictEqual(stateA.currentPageId, "p1");
  });
});

describe("enqueueBrowserTask", () => {
  test("serializes concurrent tasks (never overlapping)", async () => {
    let running = 0;
    let maxConcurrent = 0;
    const order: number[] = [];

    const makeTask = (id: number) => async () => {
      running++;
      maxConcurrent = Math.max(maxConcurrent, running);
      await new Promise((r) => setTimeout(r, 10));
      order.push(id);
      running--;
      return id;
    };

    const [r1, r2, r3] = await Promise.all([
      enqueueBrowserTask(makeTask(1)),
      enqueueBrowserTask(makeTask(2)),
      enqueueBrowserTask(makeTask(3)),
    ]);

    assert.deepEqual([r1, r2, r3], [1, 2, 3]);
    assert.deepEqual(order, [1, 2, 3], "Tasks must run in submission order");
    assert.strictEqual(maxConcurrent, 1, "Tasks must never run concurrently");
  });

  test("a failing task does not block the queue", async () => {
    const failing = enqueueBrowserTask(async () => {
      throw new Error("boom");
    });
    await assert.rejects(failing, /boom/);

    const next = await enqueueBrowserTask(async () => "after-failure");
    assert.strictEqual(next, "after-failure");
  });
});

describe("browser action tools", () => {
  async function withWorkspace(fn: (ws: string) => Promise<void>): Promise<void> {
    const ws = await mkdtemp(join(tmpdir(), "my-claw-ws-"));
    try {
      await fn(ws);
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  }

  test("upload_file refuses a path outside the workspace", async () => {
    await withWorkspace(async (ws) => {
      const state = createBrowserPageState();
      state.currentPageId = "p1";
      const tool = createBrowserUploadFileTool(createMockClient(), state, ws);
      const result = await tool.execute({ path: "/etc/passwd" });
      assert.strictEqual(result.success, false);
      assert.ok(result.error?.includes("escapes workspace"));
    });
  });

  test("upload_file reports a missing file instead of calling the sidecar", async () => {
    await withWorkspace(async (ws) => {
      const state = createBrowserPageState();
      state.currentPageId = "p1";
      const client = createMockClient();
      const tool = createBrowserUploadFileTool(client, state, ws);
      const result = await tool.execute({ path: "nope.png" });
      assert.strictEqual(result.success, false);
      assert.ok(result.error?.includes("File not found"));
      assert.strictEqual((client.uploadFile as unknown as { calls: unknown[] }).calls.length, 0);
    });
  });

  test("upload_file passes the resolved absolute path to the sidecar", async () => {
    await withWorkspace(async (ws) => {
      await writeFile(join(ws, "claw.png"), "x");
      const state = createBrowserPageState();
      state.currentPageId = "p1";
      const client = createMockClient();
      const tool = createBrowserUploadFileTool(client, state, ws);
      const result = await tool.execute({ path: "claw.png" });
      assert.strictEqual(result.success, true);
      const call = (client.uploadFile as unknown as { calls: Array<{ arguments: unknown[] }> }).calls[0];
      assert.deepStrictEqual(call?.arguments[1], [join(ws, "claw.png")]);
      assert.strictEqual(call?.arguments[2], undefined, "ref stays optional");
      assert.ok(result.output.includes("via page-input"));
    });
  });

  test("select_option surfaces which strategy worked", async () => {
    const state = createBrowserPageState();
    state.currentPageId = "p1";
    const tool = createBrowserSelectOptionTool(createMockClient(), state);
    const result = await tool.execute({ ref: 3, value: "July" });
    assert.strictEqual(result.success, true);
    assert.ok(result.output.includes('Selected "July"'));
    assert.ok(result.output.includes("via role=option"));
  });

  test("press_key forwards the key and an optional ref", async () => {
    const state = createBrowserPageState();
    state.currentPageId = "p1";
    const client = createMockClient();
    const tool = createBrowserPressKeyTool(client, state);
    const result = await tool.execute({ key: "Enter", ref: 4 });
    assert.strictEqual(result.success, true);
    const call = (client.pressKey as unknown as { calls: Array<{ arguments: unknown[] }> }).calls[0];
    assert.deepStrictEqual(call?.arguments.slice(0, 3), ["p1", "Enter", 4]);
  });

  test("scroll defaults to down and returns a fresh snapshot", async () => {
    const state = createBrowserPageState();
    state.currentPageId = "p1";
    const client = createMockClient();
    const tool = createBrowserScrollTool(client, state);
    const result = await tool.execute({});
    assert.strictEqual(result.success, true);
    const call = (client.scroll as unknown as { calls: Array<{ arguments: unknown[] }> }).calls[0];
    assert.strictEqual(call?.arguments[1], "down");
    assert.ok(result.output.includes("__ref"));
  });

  test("the action tools all require an active page", async () => {
    const client = createMockClient();
    const tools = [
      createBrowserSelectOptionTool(client, createBrowserPageState()),
      createBrowserPressKeyTool(client, createBrowserPageState()),
      createBrowserScrollTool(client, createBrowserPageState()),
    ];
    for (const tool of tools) {
      const result = await tool.execute({ ref: 1, value: "x", key: "Enter" });
      assert.strictEqual(result.success, false, `${tool.name} must refuse without a page`);
      assert.ok(result.error?.includes("No active browser page"));
    }
  });
});

describe("browser vision and wait tools", () => {
  function activeState() {
    const state = createBrowserPageState();
    state.currentPageId = "p1";
    return state;
  }

  test("click_at refuses pixel coordinates instead of round-tripping them", async () => {
    const client = createMockClient();
    const tool = createBrowserClickAtTool(client, activeState());
    const result = await tool.execute({ x: 960, y: 540 });
    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes("fractions"));
    assert.strictEqual((client.clickAt as unknown as { calls: unknown[] }).calls.length, 0);
  });

  test("click_at accepts fractions and reports where it landed", async () => {
    const client = createMockClient();
    const tool = createBrowserClickAtTool(client, activeState());
    const result = await tool.execute({ x: 0.5, y: 0.5 });
    assert.strictEqual(result.success, true);
    assert.ok(result.output.includes("960,540"));
    assert.ok(result.output.includes("1920x1080"));
  });

  test("click_at accepts the edges of the viewport", async () => {
    const tool = createBrowserClickAtTool(createMockClient(), activeState());
    for (const [x, y] of [[0, 0], [1, 1]]) {
      const result = await tool.execute({ x, y });
      assert.strictEqual(result.success, true, `${x},${y} must be valid`);
    }
  });

  test("wait_for forwards text, ref and timeout", async () => {
    const client = createMockClient();
    const tool = createBrowserWaitForTool(client, activeState());
    await tool.execute({ text: "Loaded", timeout_ms: 5000 });
    const call = (client.waitFor as unknown as { calls: Array<{ arguments: unknown[] }> }).calls[0];
    assert.deepStrictEqual(call?.arguments[1], { text: "Loaded", ref: undefined, timeoutMs: 5000 });
  });

  test("hover and drag forward their refs", async () => {
    const client = createMockClient();
    await createBrowserHoverTool(client, activeState()).execute({ ref: 3 });
    await createBrowserDragTool(client, activeState()).execute({ from_ref: 4, to_ref: 5 });
    const hover = (client.hover as unknown as { calls: Array<{ arguments: unknown[] }> }).calls[0];
    const drag = (client.drag as unknown as { calls: Array<{ arguments: unknown[] }> }).calls[0];
    assert.strictEqual(hover?.arguments[1], 3);
    assert.deepStrictEqual(drag?.arguments.slice(1, 3), [4, 5]);
  });
});

describe("browser low-level tools", () => {
  function activeState() {
    const state = createBrowserPageState();
    state.currentPageId = "p1";
    return state;
  }

  test("eval is refused unless allowEval is set", async () => {
    const client = createMockClient();
    const tool = createBrowserEvalTool(client, activeState(), { config: {} });
    const result = await tool.execute({ js: "return 1" });
    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes("allowEval"));
    assert.strictEqual((client.evaluate as unknown as { calls: unknown[] }).calls.length, 0);
  });

  test("eval runs when enabled", async () => {
    const client = createMockClient();
    const tool = createBrowserEvalTool(client, activeState(), { config: { allowEval: true } });
    const result = await tool.execute({ js: "return document.title" });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.output, '"Example"');
  });

  test("cdp is refused unless allowCdp is set", async () => {
    const tool = createBrowserCdpTool(createMockClient(), activeState(), { config: {} });
    const result = await tool.execute({ method: "DOM.getDocument" });
    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes("allowCdp"));
  });

  test("cdp refuses a method outside the allowlist without calling the sidecar", async () => {
    const client = createMockClient();
    const tool = createBrowserCdpTool(client, activeState(), { config: { allowCdp: true } });
    for (const method of ["Network.getAllCookies", "Storage.getStorageKeyForFrame", "Target.createTarget", "Browser.close"]) {
      const result = await tool.execute({ method });
      assert.strictEqual(result.success, false, `${method} must be refused`);
      assert.ok(result.error?.includes("not allowed"));
    }
    assert.strictEqual((client.cdp as unknown as { calls: unknown[] }).calls.length, 0);
  });

  test("cdp allows an allowlisted method", async () => {
    const client = createMockClient();
    const tool = createBrowserCdpTool(client, activeState(), { config: { allowCdp: true } });
    const result = await tool.execute({ method: "DOM.getDocument", params: { depth: 1 } });
    assert.strictEqual(result.success, true);
    const call = (client.cdp as unknown as { calls: Array<{ arguments: unknown[] }> }).calls[0];
    assert.strictEqual(call?.arguments[1], "DOM.getDocument");
    assert.deepStrictEqual(call?.arguments[2], { depth: 1 });
  });

  test("a custom allowlist replaces the default one", async () => {
    const tool = createBrowserCdpTool(createMockClient(), activeState(), {
      config: { allowCdp: true, cdpAllowlist: ["Page.navigate"] },
    });
    assert.strictEqual((await tool.execute({ method: "DOM.getDocument" })).success, false);
    assert.strictEqual((await tool.execute({ method: "Page.navigate" })).success, true);
  });

  test("isCdpMethodAllowed matches globs and is case-insensitive", () => {
    assert.ok(isCdpMethodAllowed("DOM.getDocument"));
    assert.ok(isCdpMethodAllowed("dom.querySelector"));
    assert.ok(isCdpMethodAllowed("Input.dispatchMouseEvent"));
    assert.ok(isCdpMethodAllowed("Runtime.evaluate"));
    assert.ok(!isCdpMethodAllowed("Runtime.addBinding"));
    assert.ok(!isCdpMethodAllowed("Network.getAllCookies"));
    assert.ok(isCdpMethodAllowed("Anything.goes", ["*"]));
  });

  test("handle_dialog forwards the decision and the prompt text", async () => {
    const client = createMockClient();
    const tool = createBrowserHandleDialogTool(client, activeState());
    const result = await tool.execute({ accept: false, prompt_text: "hello" });
    assert.strictEqual(result.success, true);
    assert.ok(result.output.includes("dismissed"));
    const call = (client.handleDialog as unknown as { calls: Array<{ arguments: unknown[] }> }).calls[0];
    assert.deepStrictEqual(call?.arguments.slice(1, 3), [false, "hello"]);
  });

  test("download defaults to a downloads folder inside the workspace", async () => {
    const client = createMockClient();
    const tool = createBrowserDownloadTool(client, activeState(), { workspaceDir: "/ws" });
    await tool.execute({});
    const call = (client.waitForDownload as unknown as { calls: Array<{ arguments: unknown[] }> }).calls[0];
    assert.strictEqual(call?.arguments[1], "/ws/downloads");
  });

  test("download honours a configured directory", async () => {
    const client = createMockClient();
    const tool = createBrowserDownloadTool(client, activeState(), {
      workspaceDir: "/ws",
      config: { downloadDir: "/data/dl" },
    });
    await tool.execute({});
    const call = (client.waitForDownload as unknown as { calls: Array<{ arguments: unknown[] }> }).calls[0];
    assert.strictEqual(call?.arguments[1], "/data/dl");
  });

  test("pdf refuses a destination outside the workspace", async () => {
    const client = createMockClient();
    const tool = createBrowserPdfTool(client, activeState(), { workspaceDir: "/ws" });
    const result = await tool.execute({ path: "/etc/evil.pdf" });
    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes("escapes workspace"));
    assert.strictEqual((client.pdf as unknown as { calls: unknown[] }).calls.length, 0);
  });

  test("pdf defaults into the download directory", async () => {
    const client = createMockClient();
    const tool = createBrowserPdfTool(client, activeState(), { workspaceDir: "/ws" });
    const result = await tool.execute({});
    assert.strictEqual(result.success, true);
    assert.ok(result.output.includes("/ws/downloads/page-"));
  });
});
