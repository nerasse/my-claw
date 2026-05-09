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
});
