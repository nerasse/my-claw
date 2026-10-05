import { test, expect } from "bun:test";
import { mockFetch } from "./mock-fetch.ts";

const answering = (text: string) => async (): Promise<Response> => new Response(text);

test("restored out of order, the mocks leave the fetch they found, and never an older one", async () => {
  const before = globalThis.fetch;
  // A test that timed out keeps its mock while the next test mocks on top, then its abandoned
  // body restores first.
  const abandoned = mockFetch(answering("old"));
  const next = mockFetch(answering("new"));
  abandoned.restore();
  expect(await (await fetch("http://x/")).text()).toBe("new");
  next.restore();
  expect(globalThis.fetch).toBe(before);
});

test("a restore called twice changes nothing more", async () => {
  const before = globalThis.fetch;
  const outer = mockFetch(answering("outer"));
  const inner = mockFetch(answering("inner"));
  inner.restore();
  inner.restore();
  expect(await (await fetch("http://x/")).text()).toBe("outer");
  outer.restore();
  expect(globalThis.fetch).toBe(before);
});
