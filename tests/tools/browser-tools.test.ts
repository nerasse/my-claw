import { test, describe } from "bun:test";
import assert from "node:assert";
import {
  createBrowserNavigateTool,
  createBrowserSnapshotTool,
  createBrowserClickTool,
  createBrowserTypeTool,
  createBrowserScreenshotTool,
  createBrowserListTabsTool,
  createBrowserFocusTabTool,
  createBrowserCloseTabTool,
  createBrowserPageState,
  enqueueBrowserTask,
} from "../../src/tools/browser.ts";
import type { BrowserClient } from "../../src/browser/client.ts";
import { createMock } from "../helpers/mock.ts";

function createMockClient(): BrowserClient {
  const snapshot = { raw: 'button "OK" [__ref="5"]', refs: [5] };
  return {
    navigate: createMock(() => Promise.resolve({ pageId: "p1", snapshot, url: "https://example.com" })),
    snapshot: createMock(() => Promise.resolve(snapshot)),
    click: createMock(() => Promise.resolve()),
    type: createMock(() => Promise.resolve()),
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
