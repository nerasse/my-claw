import { test, describe } from "bun:test";
import assert from "node:assert";
import { BrowserClient } from "../../src/browser/client.ts";
import { createBrowserActTool } from "../../src/tools/browser/act.ts";
import { createBrowserPageState, type BrowserPageState } from "../../src/tools/browser/state.ts";
import { mockFetch } from "../helpers/mock-fetch.ts";

interface Call {
  path: string;
  body: Record<string, unknown>;
  status: number;
}

/** Mock the sidecar: record every call, answer per endpoint, and let a test make one path fail. */
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
    const status = isFail ? fail.status : 200;
    calls.push({ path, body, status });
    const payload = isFail ? { error: fail.error } : (answers[path] ?? {});
    return new Response(JSON.stringify(payload), { status }) as never;
  });
  return { calls, restore: handle.restore };
}

const SIDECAR = "http://127.0.0.1:9223";
const SNAPSHOT = { snapshot: { raw: 'button "Submit" [__ref="7"]', refs: [7] } };

function armed(): { client: BrowserClient; state: BrowserPageState; tool: ReturnType<typeof createBrowserActTool> } {
  const client = new BrowserClient(SIDECAR);
  const state = createBrowserPageState();
  state.currentPageId = "p1";
  return { client, state, tool: createBrowserActTool(client, state) };
}

describe("browser_act", () => {
  test("runs a chain back to back and returns exactly ONE snapshot", async () => {
    const m = mockSidecar({ snapshot: SNAPSHOT.snapshot });
    try {
      const { tool } = armed();
      const result = await tool.execute({
        steps: [
          { action: "type", ref: 1, text: "Yassir" },
          { action: "select_option", ref: 2, value: "1997" },
          { action: "click", ref: 3 },
        ],
      });
      assert.strictEqual(result.success, true);
      assert.match(result.output, /3\/3 steps ok/);
      const snapshots = m.calls.filter((c) => c.path === "snapshot");
      assert.strictEqual(snapshots.length, 1, "one snapshot for the whole chain");
      assert.deepStrictEqual(
        m.calls.filter((c) => c.path !== "snapshot" && c.path !== "session").map((c) => c.path),
        ["type", "select-option", "click"],
      );
    } finally {
      m.restore();
    }
  });

  test("stops at the first failing step and runs nothing after it", async () => {
    const m = mockSidecar({ snapshot: SNAPSHOT.snapshot }, { path: "click", status: 500, error: "element is not clickable" });
    try {
      const { tool } = armed();
      const result = await tool.execute({
        steps: [
          { action: "type", ref: 1, text: "a" },
          { action: "click", ref: 2 },
          { action: "press_key", key: "Enter" },
        ],
      });
      assert.strictEqual(result.success, false);
      assert.match(result.error ?? "", /1\/3 steps ok, stopped at step 2/);
      assert.match(result.error ?? "", /element is not clickable/);
      assert.strictEqual(m.calls.some((c) => c.path === "press-key"), false, "step 3 never ran");
      assert.strictEqual(m.calls.filter((c) => c.path === "snapshot").length, 1, "the stop still reports the page");
    } finally {
      m.restore();
    }
  });

  test("a stale ref names the step it happened on", async () => {
    const m = mockSidecar({ snapshot: SNAPSHOT.snapshot }, { path: "select-option", status: 500, error: "Ref 9 not found — it is stale" });
    try {
      const { tool } = armed();
      const result = await tool.execute({
        steps: [
          { action: "click", ref: 1 },
          { action: "select_option", ref: 9, value: "x" },
        ],
      });
      assert.strictEqual(result.success, false);
      assert.match(result.error ?? "", /stopped at step 2/);
      assert.match(result.error ?? "", /Ref 9 not found/);
    } finally {
      m.restore();
    }
  });

  test("an empty chain is refused and nothing reaches the sidecar", async () => {
    const m = mockSidecar({});
    try {
      const { tool } = armed();
      const result = await tool.execute({ steps: [] });
      assert.strictEqual(result.success, false);
      assert.match(result.error ?? "", /non-empty steps array/);
      assert.strictEqual(m.calls.length, 0);
    } finally {
      m.restore();
    }
  });

  test("an unknown action is refused BEFORE anything runs", async () => {
    const m = mockSidecar({ snapshot: SNAPSHOT.snapshot });
    try {
      const { tool } = armed();
      const result = await tool.execute({
        steps: [{ action: "click", ref: 1 }, { action: "teleport", ref: 2 }],
      });
      assert.strictEqual(result.success, false);
      assert.match(result.error ?? "", /nothing was executed/);
      assert.match(result.error ?? "", /teleport/);
      assert.strictEqual(m.calls.length, 0, "the valid first step did not run either");
    } finally {
      m.restore();
    }
  });

  test("a missing ref is refused before anything runs", async () => {
    const m = mockSidecar({});
    try {
      const { tool } = armed();
      const result = await tool.execute({ steps: [{ action: "click" }] });
      assert.strictEqual(result.success, false);
      assert.match(result.error ?? "", /click\) needs a numeric ref/);
      assert.strictEqual(m.calls.length, 0);
    } finally {
      m.restore();
    }
  });

  test("stop_on_error=false runs every step and reports them all", async () => {
    const m = mockSidecar({ snapshot: SNAPSHOT.snapshot }, { path: "click", status: 500, error: "nope" });
    try {
      const { tool } = armed();
      const result = await tool.execute({
        steps: [{ action: "click", ref: 1 }, { action: "press_key", key: "Tab" }],
        stop_on_error: false,
      });
      assert.strictEqual(result.success, false);
      assert.strictEqual(m.calls.some((c) => c.path === "press-key"), true, "step 2 still ran");
      assert.match(result.error ?? "", /FAIL 1\. click/);
      assert.match(result.error ?? "", /ok   2\. press_key/);
    } finally {
      m.restore();
    }
  });

  test("type with submit presses Enter on the same field", async () => {
    const m = mockSidecar({ snapshot: SNAPSHOT.snapshot });
    try {
      const { tool } = armed();
      await tool.execute({ steps: [{ action: "type", ref: 4, text: "query", submit: true }] });
      const at = m.calls.findIndex((c) => c.path === "press-key");
      assert.ok(at > -1, "Enter was pressed");
      assert.strictEqual(m.calls[at]?.body.key, "Enter");
      assert.strictEqual(m.calls[at]?.body.ref, 4);
    } finally {
      m.restore();
    }
  });

  test("a navigate mid-chain moves the page the later steps use", async () => {
    const m = mockSidecar({ navigate: { pageId: "p2", url: "https://two.test", snapshot: { raw: "", refs: [] } }, snapshot: SNAPSHOT.snapshot });
    try {
      const { tool, state } = armed();
      await tool.execute({ steps: [{ action: "navigate", url: "https://two.test" }, { action: "click", ref: 1 }] });
      assert.strictEqual(state.currentPageId, "p2");
      const click = m.calls.find((c) => c.path === "click");
      assert.strictEqual(click?.body.pageId, "p2", "the click landed on the new page");
    } finally {
      m.restore();
    }
  });

  test("a chain still reports when the final snapshot itself is unavailable", async () => {
    const m = mockSidecar({}, { path: "snapshot", status: 500, error: "page is gone" });
    try {
      const { tool } = armed();
      const result = await tool.execute({ steps: [{ action: "click", ref: 1 }] });
      assert.strictEqual(result.success, true);
      assert.match(result.output, /snapshot unavailable: Error: page is gone/);
    } finally {
      m.restore();
    }
  });
});
