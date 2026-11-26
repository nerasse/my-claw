import { describe, test } from "bun:test";
import assert from "node:assert";
import { createWebSearchTool } from "../src/tools/web-search.ts";
import { mockFetch } from "./helpers/mock-fetch.ts";

describe("web_search tool", () => {
  test("builds correct SearXNG URL and parses results", async () => {
    const { restore } = mockFetch(async (input) => {
      const url = new URL(input as string);
      assert.equal(url.searchParams.get("q"), "hello world");
      assert.equal(url.searchParams.get("format"), "json");
      assert.equal(url.searchParams.get("language"), "fr");
      return new Response(
        JSON.stringify({
          results: [
            { url: "https://example.com/1", title: "First", content: "Snippet one" },
            { url: "https://example.com/2", title: "Second", content: "Snippet two" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    try {
      const tool = createWebSearchTool({ baseUrl: "https://search.kssimi.fr" });
      const result = await tool.execute({ query: "hello world", count: 5 });

      assert.equal(result.success, true);
      assert.match(result.output, /1\. First/);
      assert.match(result.output, /URL: https:\/\/example.com\/1/);
      assert.match(result.output, /Snippet one/);
      assert.match(result.output, /2\. Second/);
    } finally {
      restore();
    }
  });

  test("sends Bearer token when configured", async () => {
    let receivedHeaders: Headers | undefined;
    const { restore } = mockFetch(async (input, init) => {
      receivedHeaders = new Headers((init as RequestInit)?.headers);
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    });

    try {
      const tool = createWebSearchTool({
        baseUrl: "https://search.kssimi.fr",
        token: "secret123",
      });
      await tool.execute({ query: "test" });
      assert.equal(receivedHeaders?.get("Authorization"), "Bearer secret123");
    } finally {
      restore();
    }
  });

  test("returns error when baseUrl is missing", async () => {
    const tool = createWebSearchTool(undefined);
    const result = await tool.execute({ query: "test" });

    assert.equal(result.success, false);
    assert.match(result.error ?? "", /not configured/);
  });

  test("returns error when query is empty", async () => {
    const tool = createWebSearchTool({ baseUrl: "https://search.kssimi.fr" });
    const result = await tool.execute({ query: "" });

    assert.equal(result.success, false);
    assert.match(result.error ?? "", /query is required/);
  });

  test("handles HTTP error from SearXNG", async () => {
    const { restore } = mockFetch(async () => {
      return new Response("Forbidden", { status: 403, statusText: "Forbidden" });
    });

    try {
      const tool = createWebSearchTool({ baseUrl: "https://search.kssimi.fr" });
      const result = await tool.execute({ query: "test" });

      assert.equal(result.success, false);
      assert.match(result.error ?? "", /SearXNG search error \(403\)/);
    } finally {
      restore();
    }
  });

  test("handles invalid JSON response", async () => {
    const { restore } = mockFetch(async () => {
      return new Response("not json", { status: 200 });
    });

    try {
      const tool = createWebSearchTool({ baseUrl: "https://search.kssimi.fr" });
      const result = await tool.execute({ query: "test" });

      assert.equal(result.success, false);
      assert.match(result.error ?? "", /invalid JSON/);
    } finally {
      restore();
    }
  });

  test("uses custom language from args", async () => {
    let receivedUrl: URL | undefined;
    const { restore } = mockFetch(async (input) => {
      receivedUrl = new URL(input as string);
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    });

    try {
      const tool = createWebSearchTool({ baseUrl: "https://search.kssimi.fr", language: "fr" });
      await tool.execute({ query: "test", language: "en" });
      assert.equal(receivedUrl?.searchParams.get("language"), "en");
    } finally {
      restore();
    }
  });

  test("defaults to fr when no language is set", async () => {
    let receivedUrl: URL | undefined;
    const { restore } = mockFetch(async (input) => {
      receivedUrl = new URL(input as string);
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    });

    try {
      const tool = createWebSearchTool({ baseUrl: "https://search.kssimi.fr" });
      await tool.execute({ query: "test" });
      assert.equal(receivedUrl?.searchParams.get("language"), "fr");
    } finally {
      restore();
    }
  });

  test("flags a rate-limited/degraded backend (200 + empty results + unresponsive_engines)", async () => {
    const { restore } = mockFetch(async () => {
      return new Response(
        JSON.stringify({
          results: [],
          unresponsive_engines: [["google", "rate-limited"], ["bing", "timeout"], ["brave", "suspended"]],
        }),
        { status: 200 },
      );
    });

    try {
      const tool = createWebSearchTool({ baseUrl: "https://search.kssimi.fr" });
      const result = await tool.execute({ query: "test" });
      assert.equal(result.success, false);
      assert.match(result.error ?? "", /degraded|rate-limited/i);
      assert.match(result.error ?? "", /google: rate-limited/);
    } finally {
      restore();
    }
  });

  test("one flaky engine with empty results is a genuine empty, not a degraded outage", async () => {
    const { restore } = mockFetch(async () => {
      return new Response(JSON.stringify({ results: [], unresponsive_engines: [["bing", "timeout"]] }), { status: 200 });
    });
    try {
      const tool = createWebSearchTool({ baseUrl: "https://search.kssimi.fr" });
      const result = await tool.execute({ query: "test" });
      assert.equal(result.success, true, "a single engine down must not hard-fail search");
      assert.match(result.output, /No results found/i);
    } finally {
      restore();
    }
  });

  test("genuine empty (200 + empty results, no unresponsive engines) is a clear success", async () => {
    const { restore } = mockFetch(async () => {
      return new Response(JSON.stringify({ results: [], unresponsive_engines: [] }), { status: 200 });
    });

    try {
      const tool = createWebSearchTool({ baseUrl: "https://search.kssimi.fr" });
      const result = await tool.execute({ query: "test" });
      assert.equal(result.success, true);
      assert.match(result.output, /No results found/i);
      // An empty answer has to say what actually changes the next one: retyping the same words is
      // what 26 empty searches in one batch of research agents looked like (2026-11-24).
      assert.match(result.output, /Change the query rather than repeating it/);
      assert.match(result.output, /site:/);
    } finally {
      restore();
    }
  });

  test("degraded backend triggers a cooldown: next search is short-circuited without hitting SearXNG", async () => {
    let backendCalls = 0;
    const { restore } = mockFetch(async () => {
      backendCalls++;
      return new Response(
        JSON.stringify({ results: [], unresponsive_engines: [["brave", "too many requests"], ["ddg", "captcha"], ["mojeek", "denied"]] }),
        { status: 200 },
      );
    });

    try {
      const tool = createWebSearchTool({ baseUrl: "https://search.kssimi.fr" });

      const first = await tool.execute({ query: "events rabat" });
      assert.equal(first.success, false);
      assert.match(first.error ?? "", /degraded/i);
      assert.equal(backendCalls, 1);

      const second = await tool.execute({ query: "events rabat july" });
      assert.equal(second.success, false);
      assert.match(second.error ?? "", /cooldown/i, "second call should hit the cooldown");
      assert.match(second.error ?? "", /Do NOT retry/i);
      assert.equal(backendCalls, 1, "cooldown must not hit the backend again");
    } finally {
      restore();
    }
  });

  test("cooldown is per tool instance (fresh tool starts clean)", async () => {
    const { restore } = mockFetch(async () => {
      return new Response(JSON.stringify({ results: [{ url: "https://a.com", title: "A" }] }), { status: 200 });
    });

    try {
      const tool = createWebSearchTool({ baseUrl: "https://search.kssimi.fr" });
      const result = await tool.execute({ query: "test" });
      assert.equal(result.success, true, "a fresh tool instance must not inherit a cooldown");
    } finally {
      restore();
    }
  });

  test("its own wall is a timeout, not the run's stop", async () => {
    const { restore } = mockFetch(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          signal?.addEventListener("abort", () => reject(signal.reason ?? new DOMException("aborted", "AbortError")));
        }),
    );
    try {
      const tool = createWebSearchTool({ baseUrl: "https://search.kssimi.fr", timeoutMs: 20 });
      const run = new AbortController();
      const result = await tool.execute({ query: "hello", __signal: run.signal });

      assert.equal(result.success, false);
      assert.match(result.error ?? "", /timed out after 0.02 seconds/);
      assert.equal(run.signal.aborted, false, "the run was never stopped");
    } finally {
      restore();
    }
  });
});
