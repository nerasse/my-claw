import { test } from "bun:test";
import assert from "node:assert/strict";
import { fetchTool, htmlToText, processFetchBody } from "../../src/tools/fetch.ts";
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

test("htmlToText: strips scripts/styles/tags and decodes entities", () => {
  const html = `<!DOCTYPE html><html><head><style>.a{color:red}</style><script>var x=1</script></head>` +
    `<body><h1>Titre</h1><p>Bonjour&nbsp;&amp; bienvenue</p><ul><li>un</li><li>deux</li></ul></body></html>`;
  const text = htmlToText(html);
  assert.ok(!text.includes("color:red"), "CSS removed");
  assert.ok(!text.includes("var x=1"), "JS removed");
  assert.ok(!text.includes("<"), "tags removed");
  assert.ok(text.includes("Titre"));
  assert.ok(text.includes("Bonjour & bienvenue"), "entities decoded");
  assert.ok(text.includes("- un") && text.includes("- deux"), "list items");
});

test("fetch: HTML body is converted to text via content-type", async () => {
  const html = "<html><body><script>junk()</script><p>Hello</p></body></html>";
  const mock = mockFetch(async () => new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }));
  try {
    const result = await fetchTool.execute({ url: "https://example.com" });
    assert.equal(result.success, true);
    assert.ok(!result.output.includes("junk()"), "script stripped");
    assert.ok(!result.output.includes("<p>"), "tags stripped");
    assert.ok(result.output.includes("Hello"));
  } finally {
    mock.restore();
  }
});

test("fetch: JSON content-type is passed through untouched", async () => {
  const json = '{"a": 1, "b": "<not-html>"}';
  const mock = mockFetch(async () => new Response(json, { status: 200, headers: { "content-type": "application/json" } }));
  try {
    const result = await fetchTool.execute({ url: "https://example.com/api" });
    assert.equal(result.success, true);
    assert.equal(result.output, json);
  } finally {
    mock.restore();
  }
});

test("fetch: oversized body is windowed with a continuation offset", async () => {
  const big = "x".repeat(120_000);
  const mock = mockFetch(async () => new Response(big, { status: 200, headers: { "content-type": "text/plain" } }));
  try {
    const result = await fetchTool.execute({ url: "https://example.com/big" });
    assert.equal(result.success, true);
    assert.ok(result.output.length < big.length, "windowed");
    assert.ok(result.output.includes("caractères restants"), "continuation note present");
    assert.ok(result.output.includes("offset=50000"), "suggests next offset");
  } finally {
    mock.restore();
  }
});

test("fetch: offset reads the next window (pagination)", async () => {
  const body = "A".repeat(50_000) + "B".repeat(20_000);
  const mock = mockFetch(async () => new Response(body, { status: 200, headers: { "content-type": "text/plain" } }));
  try {
    const first = await fetchTool.execute({ url: "https://example.com/big" });
    assert.ok(first.output.startsWith("A"), "first window is the head");
    assert.ok(first.output.includes("offset=50000"));

    const next = await fetchTool.execute({ url: "https://example.com/big", offset: 50_000 });
    assert.ok(next.output.includes("suite : caractères 50000"), "labels the continuation");
    assert.ok(next.output.includes("B"), "returns the tail content");
    assert.ok(next.output.includes("fin du contenu"), "marks the end");
  } finally {
    mock.restore();
  }
});

test("fetch: offset beyond content reports end cleanly", async () => {
  const mock = mockFetch(async () => new Response("short", { status: 200, headers: { "content-type": "text/plain" } }));
  try {
    const result = await fetchTool.execute({ url: "https://example.com/s", offset: 9999 });
    assert.equal(result.success, true);
    assert.ok(result.output.includes("Rien de plus à lire"));
  } finally {
    mock.restore();
  }
});

test("processFetchBody: sniffs HTML without content-type", () => {
  const out = processFetchBody("<!doctype html><html><body><p>Hi</p></body></html>", null);
  assert.ok(!out.includes("<p>"));
  assert.ok(out.includes("Hi"));
});
