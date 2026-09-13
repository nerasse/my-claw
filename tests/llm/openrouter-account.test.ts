import { test, expect, setSystemTime } from "bun:test";
import { mockFetch } from "../helpers/mock-fetch.ts";
import {
  cachedOpenRouterAccount,
  openRouterApiKey,
  refreshOpenRouterAccount,
  resetOpenRouterAccount,
  warmOpenRouterAccount,
} from "../../src/llm/openrouter-account.ts";

/**
 * The account figures are read on a path that must never wait on the network, so everything here
 * is about what the cache answers and when -- the fetch itself is one route away from trivial.
 */

const KEY = { data: { label: "sk-or-v1-...", limit: null, limit_remaining: null, usage: 12.5, is_free_tier: false } };
const CREDITS = { data: { total_credits: 20, total_usage: 12.5 } };

/** Answers the two account routes and counts what was asked, so a cached read proves itself. */
function accountMock(over: { key?: unknown; credits?: unknown; keyStatus?: number; creditsStatus?: number } = {}) {
  const calls: string[] = [];
  const mock = mockFetch(async (input) => {
    const url = String(input);
    calls.push(url);
    const isKey = url.endsWith("/key");
    const status = isKey ? over.keyStatus ?? 200 : over.creditsStatus ?? 200;
    const body = isKey ? over.key ?? KEY : over.credits ?? CREDITS;
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  });
  return { calls, restore: mock.restore };
}

test("the key comes from the provider that declares OpenRouter, through the variable it names", () => {
  process.env["TEST_OR_KEY"] = "sk-or-test";
  try {
    const providers = {
      groq: { baseUrl: "https://api.groq.com/openai/v1", apiKeyEnv: "TEST_OR_KEY" },
      openrouter: { baseUrl: "https://openrouter.ai/api/v1", apiKeyEnv: "TEST_OR_KEY" },
    };
    expect(openRouterApiKey(providers)).toBe("sk-or-test");
    // A provider that is not OpenRouter never donates its credential, whatever it holds.
    expect(openRouterApiKey({ groq: providers.groq })).toBeUndefined();
    // Declared but unset, and declared with no variable at all: both are "no key", not a crash.
    expect(openRouterApiKey({ openrouter: { baseUrl: "https://openrouter.ai/api/v1", apiKeyEnv: "TEST_OR_ABSENT" } })).toBeUndefined();
    expect(openRouterApiKey({ openrouter: { baseUrl: "https://openrouter.ai/api/v1" } })).toBeUndefined();
    expect(openRouterApiKey(undefined)).toBeUndefined();
  } finally {
    delete process.env["TEST_OR_KEY"];
  }
});

test("a cold cache is a miss and never a fetch, and the figures land only once asked for", async () => {
  resetOpenRouterAccount();
  const mock = accountMock();
  try {
    expect(cachedOpenRouterAccount()).toBeUndefined();
    expect(mock.calls).toHaveLength(0);

    await refreshOpenRouterAccount("sk-or-test");
    expect(cachedOpenRouterAccount()).toEqual({ usageUsd: 12.5, balanceUsd: 7.5 });
    expect(mock.calls).toHaveLength(2);
  } finally {
    mock.restore();
  }
});

test("a reading stands for five minutes and is not renewed under it, then goes cold rather than stale", async () => {
  resetOpenRouterAccount();
  const mock = accountMock();
  try {
    await refreshOpenRouterAccount("sk-or-test");
    warmOpenRouterAccount("sk-or-test");
    // Still fresh: the warm is a no-op rather than a second round trip.
    expect(mock.calls).toHaveLength(2);

    setSystemTime(new Date(Date.now() + 5 * 60_000 + 1));
    // An aged figure is not shown at all: it would be read as the provider's current position.
    expect(cachedOpenRouterAccount()).toBeUndefined();
  } finally {
    setSystemTime();
    mock.restore();
  }
});

test("a failure is remembered for a minute, so a page redrawn on every call does not hammer the API", async () => {
  resetOpenRouterAccount();
  const mock = accountMock({ keyStatus: 403 });
  try {
    await refreshOpenRouterAccount("sk-or-test");
    expect(cachedOpenRouterAccount()).toBeUndefined();
    expect(mock.calls).toHaveLength(2);

    warmOpenRouterAccount("sk-or-test");
    expect(mock.calls).toHaveLength(2);

    // Past the shorter failure window the API is worth asking again.
    setSystemTime(new Date(Date.now() + 60_001));
    await refreshOpenRouterAccount("sk-or-test");
    expect(mock.calls).toHaveLength(4);
  } finally {
    setSystemTime();
    mock.restore();
  }
});

test("a balance that cannot be read costs the line one number, not the whole reading", async () => {
  resetOpenRouterAccount();
  const mock = accountMock({ creditsStatus: 403 });
  try {
    await refreshOpenRouterAccount("sk-or-test");
    expect(cachedOpenRouterAccount()).toEqual({ usageUsd: 12.5 });
  } finally {
    mock.restore();
  }
});

test("an answer that carries no usage is a failure, not a spend of zero", async () => {
  resetOpenRouterAccount();
  const mock = accountMock({ key: { data: { label: "sk-or-v1-..." } } });
  try {
    await refreshOpenRouterAccount("sk-or-test");
    expect(cachedOpenRouterAccount()).toBeUndefined();
  } finally {
    mock.restore();
  }
});

test("one refresh at a time: a second warm joins the first instead of doubling the calls", async () => {
  resetOpenRouterAccount();
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const calls: string[] = [];
  const mock = mockFetch(async (input) => {
    calls.push(String(input));
    await gate;
    return new Response(JSON.stringify(String(input).endsWith("/key") ? KEY : CREDITS), { status: 200 });
  });
  try {
    const pending = refreshOpenRouterAccount("sk-or-test");
    warmOpenRouterAccount("sk-or-test");
    expect(calls).toHaveLength(2);
    release?.();
    await pending;
    expect(cachedOpenRouterAccount()?.usageUsd).toBe(12.5);
  } finally {
    mock.restore();
  }
});
