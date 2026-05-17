import { test } from "bun:test";
import assert from "node:assert/strict";
import { fetchTool } from "../../src/tools/fetch.ts";
import { mockFetch } from "../helpers/mock-fetch.ts";

test("fetch: successful GET returns body", async () => {
  const mock = mockFetch(async () => new Response("ok body", { status: 200 }));
  try {
    const result = await fetchTool.execute({ url: "https://example.com" });
    assert.equal(result.success, true);
    assert.equal(result.output, "ok body");
  } finally {
    mock.restore();
  }
});

test("fetch: HTTP 404 returns success false", async () => {
  const mock = mockFetch(async () => new Response("not found", { status: 404 }));
  try {
    const result = await fetchTool.execute({ url: "https://example.com/missing" });
    assert.equal(result.success, false);
    assert.ok(result.error?.includes("HTTP 404"));
  } finally {
    mock.restore();
  }
});

test("fetch: empty URL returns success false", async () => {
  const result = await fetchTool.execute({ url: "" });
  assert.equal(result.success, false);
});

test("fetch: POST with body sends correct method and body", async () => {
  let capturedMethod = "";
  let capturedBody = "";
  const mock = mockFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
    capturedMethod = init?.method ?? "GET";
    capturedBody = typeof init?.body === "string" ? init.body : "";
    return new Response("created", { status: 200 });
  });
  try {
    const result = await fetchTool.execute({ url: "https://example.com/api", method: "POST", body: '{"key":"val"}' });
    assert.equal(result.success, true);
    assert.equal(capturedMethod, "POST");
    assert.equal(capturedBody, '{"key":"val"}');
  } finally {
    mock.restore();
  }
});

test("fetch: network error returns success false", async () => {
  const mock = mockFetch(async () => {
    throw new Error("network down");
  });
  try {
    const result = await fetchTool.execute({ url: "https://example.com" });
    assert.equal(result.success, false);
    assert.ok(result.error?.includes("network down") || result.error?.includes("Failed"));
  } finally {
    mock.restore();
  }
});
