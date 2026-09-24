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
  createBrowserListWindowsTool,
  createBrowserFocusTabTool,
  createBrowserCloseTabTool,
} from "../../src/tools/browser/index.ts";
import type { BrowserClient } from "../../src/browser/client.ts";
import { createMock } from "../helpers/mock.ts";
import { oneTab } from "../helpers/browser-windows.ts";

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
    listTabs: createMock(() => Promise.resolve([{ id: "p1", url: "https://example.com", title: "" }])),
  } as unknown as BrowserClient;
}

describe("browser tools", () => {
  test("navigate takes localhost, like any other host", async () => {
    const tool = createBrowserNavigateTool(createMockClient(), oneTab().pages);
    const result = await tool.execute({ window: 1, __sessionId: "run", url: "http://localhost:8080" });
    assert.strictEqual(result.success, true);
  });

  test("navigate rejects file protocol", async () => {
    const tool = createBrowserNavigateTool(createMockClient(), oneTab().pages);
    const result = await tool.execute({ window: 1, __sessionId: "run", url: "file:///etc/passwd" });
    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes("file://"));
  });

  test("navigate reuses the run's tab in its window, and the page it lands on becomes the current one", async () => {
    const client = createMockClient();
    const { pages, call } = oneTab("p0");
    const tool = createBrowserNavigateTool(client, pages);
    const result = await tool.execute(call({ url: "https://example.com" }));
    assert.strictEqual(result.success, true);
    assert.ok(result.output.includes("OK"));
    const sent = (client.navigate as unknown as { calls: { arguments: unknown[] }[] }).calls[0]?.arguments[1];
    assert.deepStrictEqual(sent, { pageId: "p0", windowId: 1 });
    assert.strictEqual(await pages.page(call()), "p1");
  });

  test("navigate with new_tab opens the tab in the named window, never wherever the focus is", async () => {
    const client = createMockClient();
    const { pages, call } = oneTab("p0");
    await createBrowserNavigateTool(client, pages).execute(call({ url: "https://example.com", new_tab: true }));
    const sent = (client.navigate as unknown as { calls: { arguments: unknown[] }[] }).calls[0]?.arguments[1];
    assert.deepStrictEqual(sent, { windowId: 1, newTab: true });
  });

  test("snapshot, click and type need a window", async () => {
    const client = createMockClient();
    const { pages } = oneTab();
    for (const [tool, args] of [
      [createBrowserSnapshotTool(client, pages), {}],
      [createBrowserClickTool(client, pages), { ref: 5 }],
      [createBrowserTypeTool(client, pages), { ref: 3, text: "hello" }],
    ] as const) {
      const result = await tool.execute({ __sessionId: "run", ...args });
      assert.strictEqual(result.success, false, `${tool.name} must refuse without a window`);
      assert.ok(result.error?.includes("Name the window"));
    }
    assert.strictEqual((client.click as unknown as { calls: unknown[] }).calls.length, 0);
  });

  test("every page tool declares the window it acts in as required", async () => {
    const client = createMockClient();
    const { pages } = oneTab();
    for (const tool of [createBrowserSnapshotTool(client, pages), createBrowserClickTool(client, pages), createBrowserTypeTool(client, pages)]) {
      const params = tool.parameters as { required?: string[]; properties: Record<string, unknown> };
      assert.ok(params.required?.includes("window"), tool.name);
      assert.ok("window" in params.properties, tool.name);
    }
  });

  test("click uses the current page id", async () => {
    const client = createMockClient();
    const state = oneTab("p7").pages;
    const tool = createBrowserClickTool(client, state);
    const result = await tool.execute({ window: 1, __sessionId: "run", ref: 5 });
    assert.strictEqual(result.success, true);
    assert.strictEqual((client.click as unknown as { calls: { arguments: unknown[] }[] }).calls[0]?.arguments[0], "p7");
  });

  test("screenshot returns attachment", async () => {
    const state = oneTab("p1").pages;
    const tool = createBrowserScreenshotTool(createMockClient(), state);
    const result = await tool.execute({ window: 1, __sessionId: "run", full_page: true });
    assert.strictEqual(result.success, true);
    assert.ok(result.attachments);
    assert.strictEqual(result.attachments![0]!.type, "image");
  });

  test("list_windows shows the windows with their tabs, and whose they are", async () => {
    const { pages, call } = oneTab();
    const result = await createBrowserListWindowsTool(pages).execute(call());
    assert.strictEqual(result.success, true);
    assert.ok(result.output.includes("Window 1 (free)"));
    assert.ok(result.output.includes("[1] https://example.com"));
  });

  test("focus_tab makes the tab the run's current one in its window", async () => {
    const client = createMockClient();
    const { pages, call } = oneTab("p1");
    const result = await createBrowserFocusTabTool(client, pages).execute(call({ tab: 1 }));
    assert.strictEqual(result.success, true);
    assert.ok(result.output.includes("tab [1] of window 1"));
    assert.strictEqual((client.snapshot as unknown as { calls: { arguments: unknown[] }[] }).calls[0]?.arguments[0], "p1");
  });

  test("close_tab closes a tab of a window", async () => {
    const { pages, call } = oneTab();
    const result = await createBrowserCloseTabTool(pages).execute(call({ tab: 1 }));
    assert.strictEqual(result.success, true);
    assert.ok(result.output.includes("closed"));
  });

  test("two runs never share a window: the second is sent elsewhere, the first is untouched", async () => {
    const client = createMockClient();
    const { pages } = oneTab("p1");
    const clickA = await createBrowserClickTool(client, pages).execute({ window: 1, __sessionId: "run-A", ref: 5 });
    assert.strictEqual(clickA.success, true);
    const clickB = await createBrowserClickTool(client, pages).execute({ window: 1, __sessionId: "run-B", ref: 5 });
    assert.strictEqual(clickB.success, false);
    assert.ok(clickB.error?.includes("in use by another task"));
    assert.strictEqual((client.click as unknown as { calls: unknown[] }).calls.length, 1);
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

  test("upload_file takes a path outside the workspace", async () => {
    await withWorkspace(async (ws) => {
      const state = oneTab("p1").pages;
      const client = createMockClient();
      const tool = createBrowserUploadFileTool(client, state, ws);
      const result = await tool.execute({ window: 1, __sessionId: "run", path: "/etc/passwd" });
      assert.strictEqual(result.success, true);
      const call = (client.uploadFile as unknown as { calls: Array<{ arguments: unknown[] }> }).calls[0];
      assert.deepStrictEqual(call?.arguments[1], ["/etc/passwd"]);
    });
  });

  test("upload_file reports a missing file instead of calling the sidecar", async () => {
    await withWorkspace(async (ws) => {
      const state = oneTab("p1").pages;
      const client = createMockClient();
      const tool = createBrowserUploadFileTool(client, state, ws);
      const result = await tool.execute({ window: 1, __sessionId: "run", path: "nope.png" });
      assert.strictEqual(result.success, false);
      assert.ok(result.error?.includes("File not found"));
      assert.strictEqual((client.uploadFile as unknown as { calls: unknown[] }).calls.length, 0);
    });
  });

  test("upload_file passes the resolved absolute path to the sidecar", async () => {
    await withWorkspace(async (ws) => {
      await writeFile(join(ws, "claw.png"), "x");
      const state = oneTab("p1").pages;
      const client = createMockClient();
      const tool = createBrowserUploadFileTool(client, state, ws);
      const result = await tool.execute({ window: 1, __sessionId: "run", path: "claw.png" });
      assert.strictEqual(result.success, true);
      const call = (client.uploadFile as unknown as { calls: Array<{ arguments: unknown[] }> }).calls[0];
      assert.deepStrictEqual(call?.arguments[1], [join(ws, "claw.png")]);
      assert.strictEqual(call?.arguments[2], undefined, "ref stays optional");
      assert.ok(result.output.includes("via page-input"));
    });
  });

  test("select_option surfaces which strategy worked", async () => {
    const state = oneTab("p1").pages;
    const tool = createBrowserSelectOptionTool(createMockClient(), state);
    const result = await tool.execute({ window: 1, __sessionId: "run", ref: 3, value: "July" });
    assert.strictEqual(result.success, true);
    assert.ok(result.output.includes('Selected "July"'));
    assert.ok(result.output.includes("via role=option"));
  });

  test("press_key forwards the key and an optional ref", async () => {
    const state = oneTab("p1").pages;
    const client = createMockClient();
    const tool = createBrowserPressKeyTool(client, state);
    const result = await tool.execute({ window: 1, __sessionId: "run", key: "Enter", ref: 4 });
    assert.strictEqual(result.success, true);
    const call = (client.pressKey as unknown as { calls: Array<{ arguments: unknown[] }> }).calls[0];
    assert.deepStrictEqual(call?.arguments.slice(0, 3), ["p1", "Enter", 4]);
  });

  test("scroll defaults to down and returns a fresh snapshot", async () => {
    const state = oneTab("p1").pages;
    const client = createMockClient();
    const tool = createBrowserScrollTool(client, state);
    const result = await tool.execute({ window: 1, __sessionId: "run" });
    assert.strictEqual(result.success, true);
    const call = (client.scroll as unknown as { calls: Array<{ arguments: unknown[] }> }).calls[0];
    assert.strictEqual(call?.arguments[1], "down");
    assert.ok(result.output.includes("__ref"));
  });

  test("the action tools all need a window", async () => {
    const client = createMockClient();
    const { pages } = oneTab();
    const tools = [
      createBrowserSelectOptionTool(client, pages),
      createBrowserPressKeyTool(client, pages),
      createBrowserScrollTool(client, pages),
    ];
    for (const tool of tools) {
      const result = await tool.execute({ __sessionId: "run", ref: 1, value: "x", key: "Enter" });
      assert.strictEqual(result.success, false, `${tool.name} must refuse without a window`);
      assert.ok(result.error?.includes("Name the window"));
    }
  });
});

describe("browser vision and wait tools", () => {
  function activeState() {
    const state = oneTab("p1").pages;
    return state;
  }

  test("click_at refuses pixel coordinates instead of round-tripping them", async () => {
    const client = createMockClient();
    const tool = createBrowserClickAtTool(client, activeState());
    const result = await tool.execute({ window: 1, __sessionId: "run", x: 960, y: 540 });
    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes("fractions"));
    assert.strictEqual((client.clickAt as unknown as { calls: unknown[] }).calls.length, 0);
  });

  test("click_at accepts fractions and reports where it landed", async () => {
    const client = createMockClient();
    const tool = createBrowserClickAtTool(client, activeState());
    const result = await tool.execute({ window: 1, __sessionId: "run", x: 0.5, y: 0.5 });
    assert.strictEqual(result.success, true);
    assert.ok(result.output.includes("960,540"));
    assert.ok(result.output.includes("1920x1080"));
  });

  test("click_at accepts the edges of the viewport", async () => {
    const tool = createBrowserClickAtTool(createMockClient(), activeState());
    for (const [x, y] of [[0, 0], [1, 1]]) {
      const result = await tool.execute({ window: 1, __sessionId: "run", x, y });
      assert.strictEqual(result.success, true, `${x},${y} must be valid`);
    }
  });

  test("wait_for forwards text, ref and timeout", async () => {
    const client = createMockClient();
    const tool = createBrowserWaitForTool(client, activeState());
    await tool.execute({ window: 1, __sessionId: "run", text: "Loaded", timeout_ms: 5000 });
    const call = (client.waitFor as unknown as { calls: Array<{ arguments: unknown[] }> }).calls[0];
    assert.deepStrictEqual(call?.arguments[1], { text: "Loaded", ref: undefined, timeoutMs: 5000 });
  });

  test("hover and drag forward their refs", async () => {
    const client = createMockClient();
    await createBrowserHoverTool(client, activeState()).execute({ window: 1, __sessionId: "run", ref: 3 });
    await createBrowserDragTool(client, activeState()).execute({ window: 1, __sessionId: "run", from_ref: 4, to_ref: 5 });
    const hover = (client.hover as unknown as { calls: Array<{ arguments: unknown[] }> }).calls[0];
    const drag = (client.drag as unknown as { calls: Array<{ arguments: unknown[] }> }).calls[0];
    assert.strictEqual(hover?.arguments[1], 3);
    assert.deepStrictEqual(drag?.arguments.slice(1, 3), [4, 5]);
  });
});

describe("browser low-level tools", () => {
  function activeState() {
    const state = oneTab("p1").pages;
    return state;
  }

  test("eval is refused unless allowEval is set", async () => {
    const client = createMockClient();
    const tool = createBrowserEvalTool(client, activeState(), { config: {} });
    const result = await tool.execute({ window: 1, __sessionId: "run", js: "return 1" });
    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes("allowEval"));
    assert.strictEqual((client.evaluate as unknown as { calls: unknown[] }).calls.length, 0);
  });

  test("eval runs when enabled", async () => {
    const client = createMockClient();
    const tool = createBrowserEvalTool(client, activeState(), { config: { allowEval: true } });
    const result = await tool.execute({ window: 1, __sessionId: "run", js: "return document.title" });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.output, '"Example"');
  });

  test("cdp is refused unless allowCdp is set", async () => {
    const tool = createBrowserCdpTool(createMockClient(), activeState(), { config: {} });
    const result = await tool.execute({ window: 1, __sessionId: "run", method: "DOM.getDocument" });
    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes("allowCdp"));
  });

  test("cdp refuses a method outside the allowlist without calling the sidecar", async () => {
    const client = createMockClient();
    const tool = createBrowserCdpTool(client, activeState(), { config: { allowCdp: true } });
    for (const method of ["Network.getAllCookies", "Storage.getStorageKeyForFrame", "Target.createTarget", "Browser.close"]) {
      const result = await tool.execute({ window: 1, __sessionId: "run", method });
      assert.strictEqual(result.success, false, `${method} must be refused`);
      assert.ok(result.error?.includes("not allowed"));
    }
    assert.strictEqual((client.cdp as unknown as { calls: unknown[] }).calls.length, 0);
  });

  test("cdp allows an allowlisted method", async () => {
    const client = createMockClient();
    const tool = createBrowserCdpTool(client, activeState(), { config: { allowCdp: true } });
    const result = await tool.execute({ window: 1, __sessionId: "run", method: "DOM.getDocument", params: { depth: 1 } });
    assert.strictEqual(result.success, true);
    const call = (client.cdp as unknown as { calls: Array<{ arguments: unknown[] }> }).calls[0];
    assert.strictEqual(call?.arguments[1], "DOM.getDocument");
    assert.deepStrictEqual(call?.arguments[2], { depth: 1 });
  });

  test("a custom allowlist replaces the default one", async () => {
    const tool = createBrowserCdpTool(createMockClient(), activeState(), {
      config: { allowCdp: true, cdpAllowlist: ["Page.navigate"] },
    });
    assert.strictEqual((await tool.execute({ window: 1, __sessionId: "run", method: "DOM.getDocument" })).success, false);
    assert.strictEqual((await tool.execute({ window: 1, __sessionId: "run", method: "Page.navigate" })).success, true);
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
    const result = await tool.execute({ window: 1, __sessionId: "run", accept: false, prompt_text: "hello" });
    assert.strictEqual(result.success, true);
    assert.ok(result.output.includes("dismissed"));
    const call = (client.handleDialog as unknown as { calls: Array<{ arguments: unknown[] }> }).calls[0];
    assert.deepStrictEqual(call?.arguments.slice(1, 3), [false, "hello"]);
  });

  test("download defaults to a downloads folder inside the workspace", async () => {
    const client = createMockClient();
    const tool = createBrowserDownloadTool(client, activeState(), { workspaceDir: "/ws" });
    await tool.execute({ window: 1, __sessionId: "run" });
    const call = (client.waitForDownload as unknown as { calls: Array<{ arguments: unknown[] }> }).calls[0];
    assert.strictEqual(call?.arguments[1], "/ws/downloads");
  });

  test("download honours a configured directory", async () => {
    const client = createMockClient();
    const tool = createBrowserDownloadTool(client, activeState(), {
      workspaceDir: "/ws",
      config: { downloadDir: "/data/dl" },
    });
    await tool.execute({ window: 1, __sessionId: "run" });
    const call = (client.waitForDownload as unknown as { calls: Array<{ arguments: unknown[] }> }).calls[0];
    assert.strictEqual(call?.arguments[1], "/data/dl");
  });

  test("pdf takes a destination outside the workspace", async () => {
    const client = createMockClient();
    const tool = createBrowserPdfTool(client, activeState(), { workspaceDir: "/ws" });
    const result = await tool.execute({ window: 1, __sessionId: "run", path: "/etc/evil.pdf" });
    assert.strictEqual(result.success, true);
    assert.ok(result.output.includes("/etc/evil.pdf"));
  });

  test("pdf defaults into the download directory", async () => {
    const client = createMockClient();
    const tool = createBrowserPdfTool(client, activeState(), { workspaceDir: "/ws" });
    const result = await tool.execute({ window: 1, __sessionId: "run" });
    assert.strictEqual(result.success, true);
    assert.ok(result.output.includes("/ws/downloads/page-"));
  });
});
