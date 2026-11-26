import { test } from "bun:test";
import assert from "node:assert/strict";
import { fetchTool, createFetchTool, htmlToText, processFetchBody, isJsRenderedShell } from "../../src/tools/fetch.ts";
import { AbortedError } from "../../src/core/aborted.ts";
import { mockFetch } from "../helpers/mock-fetch.ts";

/** A host that accepts the connection and never answers: the incident's first domino. */
function neverAnswers(): { restore(): void } {
  return mockFetch(
    (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener("abort", () => reject(signal.reason ?? new DOMException("aborted", "AbortError")));
      }),
  );
}


/**
 * Every call here is mocked, so the work is microseconds. The budget is not about this file: it
 * went red on CI as collateral, right after a starved test in another file timed out and restored
 * its mocks with requests still in flight. Kept high enough that only a genuine hang trips it.
 */
const STARVED_RUNNER_TIMEOUT_MS = 30_000;

test("fetch: successful GET returns body", async () => {
  const mock = mockFetch(async () => new Response("ok body", { status: 200 }));
  try {
    const result = await fetchTool.execute({ url: "https://example.com" });
    assert.equal(result.success, true);
    assert.equal(result.output, "ok body");
  } finally {
    mock.restore();
  }
}, STARVED_RUNNER_TIMEOUT_MS);

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
  const mock = mockFetch(async (input?: string | URL | Request, init?: RequestInit) => {
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

test("isJsRenderedShell: detects a large SPA shell with no readable text", () => {
  const shell = `<!doctype html><html><head><title>x</title></head><body><div id="root">-</div><script>${"x".repeat(20_000)}</script></body></html>`;
  assert.equal(isJsRenderedShell(shell, "text/html"), true);
});

test("isJsRenderedShell: a real article page is not a shell", () => {
  const article = `<!doctype html><html><body><article>${"Real readable words about events in the city. ".repeat(200)}</article></body></html>`;
  assert.equal(isJsRenderedShell(article, "text/html"), false);
});

test("isJsRenderedShell: small pages and non-HTML are not shells", () => {
  assert.equal(isJsRenderedShell("<html><body>-</body></html>", "text/html"), false, "small page");
  assert.equal(isJsRenderedShell(`{"data":"${"x".repeat(10_000)}"}`, "application/json"), false, "json");
});

test("fetch: JS-rendered shell output carries the delegate_browser_task hint", async () => {
  const shell = `<!doctype html><html><body><div id="app">- | -</div><script>${"y".repeat(30_000)}</script></body></html>`;
  const mock = mockFetch(async () => new Response(shell, { status: 200, headers: { "content-type": "text/html" } }));
  try {
    const result = await fetchTool.execute({ url: "https://spa.example.com/profile" });
    assert.equal(result.success, true);
    assert.ok(result.output.includes("JavaScript-rendered"), "should flag the JS shell");
    assert.ok(result.output.includes("delegate_browser_task"), "should point to the browser subagent");
  } finally {
    mock.restore();
  }
});

test("fetch: normal HTML page gets no JS-shell hint", async () => {
  const page = `<!doctype html><html><body><p>${"Plenty of readable content here. ".repeat(300)}</p></body></html>`;
  const mock = mockFetch(async () => new Response(page, { status: 200, headers: { "content-type": "text/html" } }));
  try {
    const result = await fetchTool.execute({ url: "https://example.com/article" });
    assert.equal(result.success, true);
    assert.ok(!result.output.includes("JavaScript-rendered"));
  } finally {
    mock.restore();
  }
});

test("fetch: 308 redirect preserves method and body (POST stays POST)", async () => {
  const seen: Array<{ method: string; body: string | null }> = [];
  const mock = mockFetch(async (input, init) => {
    const url = String(input);
    seen.push({ method: (init as RequestInit)?.method ?? "GET", body: ((init as RequestInit)?.body as string) ?? null });
    if (url.endsWith("/old")) {
      return new Response(null, { status: 308, headers: { location: "https://example.com/new" } });
    }
    return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
  });
  try {
    const result = await fetchTool.execute({ url: "https://example.com/old", method: "POST", body: "payload" });
    assert.equal(result.success, true);
    // Second hop must still be POST with the body (308 preserves them).
    assert.equal(seen[1]?.method, "POST");
    assert.equal(seen[1]?.body, "payload");
  } finally {
    mock.restore();
  }
});

test("fetch: 302 redirect downgrades to GET and drops the body", async () => {
  const seen: string[] = [];
  const mock = mockFetch(async (input, init) => {
    const url = String(input);
    seen.push((init as RequestInit)?.method ?? "GET");
    if (url.endsWith("/old")) {
      return new Response(null, { status: 302, headers: { location: "https://example.com/new" } });
    }
    return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
  });
  try {
    await fetchTool.execute({ url: "https://example.com/old", method: "POST", body: "payload" });
    assert.equal(seen[1], "GET");
  } finally {
    mock.restore();
  }
});

test("fetch: 3xx without Location returns a clear error (not 'too many redirects')", async () => {
  const mock = mockFetch(async () => new Response(null, { status: 301 }));
  try {
    const result = await fetchTool.execute({ url: "https://example.com/x" });
    assert.equal(result.success, false);
    assert.match(result.error ?? "", /no Location header/i);
  } finally {
    mock.restore();
  }
});

test("fetch: its own wall is a timeout, not the run's stop", async () => {
  // Measured 2026-09-21: this exact shape ended a research run as "run stopped by user", took a
  // sub-agent card down as "aborted" and left two sibling sub-agents running for 5 and 9 minutes.
  const mock = neverAnswers();
  try {
    const tool = createFetchTool({ timeoutMs: 20 });
    const run = new AbortController();
    const result = await tool.execute({ url: "https://slow.example.com/", __signal: run.signal });

    assert.equal(result.success, false, "a wall that fires is a failure result");
    assert.match(result.error ?? "", /timed out after 0.02 seconds/);
    assert.equal(run.signal.aborted, false, "and the run is untouched");
  } finally {
    mock.restore();
  }
});

test("fetch: a real Stop still cuts the request and leaves as an abort", async () => {
  const mock = neverAnswers();
  try {
    const tool = createFetchTool({ timeoutMs: 60_000 });
    const run = new AbortController();
    const call = tool.execute({ url: "https://slow.example.com/", __signal: run.signal });
    run.abort();
    await assert.rejects(() => call, AbortedError);
  } finally {
    mock.restore();
  }
});

test("fetch: retryDelayFor reads seconds, dates, and caps a host's ask", async () => {
  const { retryDelayFor } = await import("../../src/tools/fetch.ts");
  assert.equal(retryDelayFor(null, 1500), 1500);
  assert.equal(retryDelayFor("2", 1500), 2000);
  assert.equal(retryDelayFor("9999", 1500), 10_000);
  const past = new Date(Date.now() - 60_000).toUTCString();
  assert.equal(retryDelayFor(past, 1500), 0);
});

test("fetch: a transient 503 on GET is retried once, honoring Retry-After", async () => {
  let calls = 0;
  const mock = mockFetch(async () => {
    calls += 1;
    if (calls === 1) return new Response("busy", { status: 503, headers: { "retry-after": "0" } });
    return new Response("ok now", { status: 200 });
  });
  try {
    const tool = createFetchTool({ retryDelayMs: 1 });
    const result = await tool.execute({ url: "https://retry.example.com/page" });
    assert.equal(result.success, true);
    assert.equal(result.output, "ok now");
    assert.equal(calls, 2);
  } finally {
    mock.restore();
  }
});

test("fetch: the retry happens once, then the failure is the answer", async () => {
  let calls = 0;
  const mock = mockFetch(async () => {
    calls += 1;
    return new Response("still busy", { status: 503 });
  });
  try {
    const tool = createFetchTool({ retryDelayMs: 1 });
    const result = await tool.execute({ url: "https://busy.example.com/page" });
    assert.equal(result.success, false);
    assert.match(result.error ?? "", /HTTP 503/);
    assert.equal(calls, 2);
  } finally {
    mock.restore();
  }
});

test("fetch: a side-effecting method is never replayed", async () => {
  let calls = 0;
  const mock = mockFetch(async () => {
    calls += 1;
    return new Response("nope", { status: 429 });
  });
  try {
    const tool = createFetchTool({ retryDelayMs: 1 });
    const result = await tool.execute({ url: "https://busy.example.com/order", method: "POST", body: "{}" });
    assert.equal(result.success, false);
    assert.equal(calls, 1);
  } finally {
    mock.restore();
  }
});

test("fetch: a successful GET is reused, and pages from the cache", async () => {
  const body = "x".repeat(120_000);
  let calls = 0;
  const mock = mockFetch(async () => {
    calls += 1;
    return new Response(body, { status: 200, headers: { "content-type": "text/plain" } });
  });
  try {
    const tool = createFetchTool();
    const first = await tool.execute({ url: "https://cache.example.com/big" });
    assert.equal(first.success, true);
    assert.equal(calls, 1);
    const second = await tool.execute({ url: "https://cache.example.com/big", offset: 50_000 });
    assert.equal(second.success, true);
    assert.match(second.output, /caractères 50000–100000 sur 120000/);
    assert.equal(calls, 1, "the second read never left the cache");
  } finally {
    mock.restore();
  }
});

test("fetch: an expired cache entry is fetched again", async () => {
  let calls = 0;
  const mock = mockFetch(async () => {
    calls += 1;
    return new Response("fresh", { status: 200 });
  });
  try {
    const tool = createFetchTool({ cacheTtlMs: -1 });
    await tool.execute({ url: "https://ttl.example.com/" });
    await tool.execute({ url: "https://ttl.example.com/" });
    assert.equal(calls, 2);
  } finally {
    mock.restore();
  }
});

test("fetch: a failed GET is never cached", async () => {
  let calls = 0;
  const mock = mockFetch(async () => {
    calls += 1;
    return new Response("boom", { status: 500 });
  });
  try {
    const tool = createFetchTool({ retryDelayMs: 1 });
    const first = await tool.execute({ url: "https://fail.example.com/" });
    assert.equal(first.success, false);
    const second = await tool.execute({ url: "https://fail.example.com/" });
    assert.equal(second.success, false);
    assert.equal(calls, 4, "two calls, each retried once");
  } finally {
    mock.restore();
  }
});

test("fetch: a 404 says where to go next, and the dead URL is not paid twice", async () => {
  let calls = 0;
  const mock = mockFetch(async () => {
    calls += 1;
    return new Response("gone", { status: 404 });
  });
  try {
    const tool = createFetchTool();
    const first = await tool.execute({ url: "https://docs.example.com/guessed/path" });
    assert.equal(first.success, false);
    assert.match(first.error ?? "", /nothing is at this URL/);
    assert.match(first.error ?? "", /web_search/);
    // The second ask is answered from the memo: a model guessing paths at a doc tree used to pay
    // the whole round trip again for the same dead address.
    const second = await tool.execute({ url: "https://docs.example.com/guessed/path" });
    assert.equal(second.success, false);
    assert.match(second.error ?? "", /already asked/);
    assert.equal(calls, 1);
  } finally {
    mock.restore();
  }
});

test("fetch: a refusal and a rate limit each name their own next move", async () => {
  const forbidden = mockFetch(async () => new Response("no", { status: 403 }));
  try {
    const result = await fetchTool.execute({ url: "https://example.com/private" });
    assert.match(result.error ?? "", /refused access/);
    assert.doesNotMatch(result.error ?? "", /web_search/);
  } finally {
    forbidden.restore();
  }
  const limited = mockFetch(async () => new Response("slow down", { status: 429 }));
  try {
    const result = await fetchTool.execute({ url: "https://example.com/rate" });
    assert.match(result.error ?? "", /rate limiting/);
  } finally {
    limited.restore();
  }
});

test("fetch: the dead-URL memo is a GET's memory, and a 5xx is not a dead end", async () => {
  let postCalls = 0;
  const notFound = mockFetch(async () => {
    postCalls += 1;
    return new Response("gone", { status: 404 });
  });
  try {
    const tool = createFetchTool();
    await tool.execute({ url: "https://docs.example.com/maybe" });
    // A body changes the request: the memo must not answer for it.
    const post = await tool.execute({ url: "https://docs.example.com/maybe", method: "POST", body: "x" });
    assert.equal(post.success, false);
    assert.equal(postCalls, 2, "the POST reached the host");
  } finally {
    notFound.restore();
  }

  let hits = 0;
  const flaky = mockFetch(async () => {
    hits += 1;
    return new Response("boom", { status: 500 });
  });
  try {
    const tool = createFetchTool({ retryDelayMs: 0 });
    const first = await tool.execute({ url: "https://example.com/flaky" });
    assert.equal(first.success, false);
    assert.match(first.error ?? "", /5xx may pass on another try/);
    assert.equal(hits, 2, "one retry, as documented");
    // A 5xx is exactly the answer that may change: asking again must reach the host.
    await tool.execute({ url: "https://example.com/flaky" });
    assert.equal(hits, 4);
  } finally {
    flaky.restore();
  }
});
