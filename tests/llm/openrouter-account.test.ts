import { test, expect, setSystemTime } from "bun:test";
import { mockFetch } from "../helpers/mock-fetch.ts";
import { hooks } from "../../src/hooks/index.ts";
import {
  cachedOpenRouterAccount,
  openRouterLedgers,
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

test("one ledger per key, read from the providers that declare OpenRouter, through the variable they name", () => {
  process.env["TEST_OR_KEY"] = "sk-or-test";
  process.env["TEST_OR_KEY2"] = "sk-or-work";
  try {
    const openrouter = { baseUrl: "https://openrouter.ai/api/v1", apiKeyEnv: "TEST_OR_KEY" };
    const providers = {
      groq: { baseUrl: "https://api.groq.com/openai/v1", apiKeyEnv: "TEST_OR_KEY" },
      openrouter,
      work: { baseUrl: "https://openrouter.ai/api/v1", apiKeyEnv: "TEST_OR_KEY2" },
      // The same variable as `openrouter`: the same account, so the same ledger, not a second one.
      alias: openrouter,
    };
    expect(openRouterLedgers(providers)).toEqual([
      { apiKey: "sk-or-test", providerKeys: ["openrouter", "alias"] },
      { apiKey: "sk-or-work", providerKeys: ["work"] },
    ]);
    // A provider that is not OpenRouter never donates its credential, whatever it holds.
    expect(openRouterLedgers({ groq: providers.groq })).toEqual([]);
    // Declared but unset, and declared with no variable at all: both are "no key", not a crash.
    expect(openRouterLedgers({ openrouter: { baseUrl: "https://openrouter.ai/api/v1", apiKeyEnv: "TEST_OR_ABSENT" } })).toEqual([]);
    expect(openRouterLedgers({ openrouter: { baseUrl: "https://openrouter.ai/api/v1" } })).toEqual([]);
    expect(openRouterLedgers(undefined)).toEqual([]);
  } finally {
    delete process.env["TEST_OR_KEY"];
    delete process.env["TEST_OR_KEY2"];
  }
});

test("two keys are two ledgers: one key's reading never answers for the other", async () => {
  resetOpenRouterAccount();
  const mock = accountMock();
  try {
    await refreshOpenRouterAccount("sk-or-test");
    expect(cachedOpenRouterAccount("sk-or-test")?.usageUsd).toBe(12.5);
    expect(cachedOpenRouterAccount("sk-or-work")).toBeUndefined();
    // And the second key is fetched, not skipped as already fresh.
    warmOpenRouterAccount("sk-or-work");
    expect(mock.calls).toHaveLength(4);
  } finally {
    mock.restore();
  }
});

test("a cold cache is a miss and never a fetch, and the figures land only once asked for", async () => {
  resetOpenRouterAccount();
  const mock = accountMock();
  try {
    expect(cachedOpenRouterAccount("sk-or-test")).toBeUndefined();
    expect(mock.calls).toHaveLength(0);

    await refreshOpenRouterAccount("sk-or-test");
    expect(cachedOpenRouterAccount("sk-or-test")).toEqual({ usageUsd: 12.5, balanceUsd: 7.5 });
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
    expect(cachedOpenRouterAccount("sk-or-test")).toBeUndefined();
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
    expect(cachedOpenRouterAccount("sk-or-test")).toBeUndefined();
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
    expect(cachedOpenRouterAccount("sk-or-test")).toEqual({ usageUsd: 12.5 });
  } finally {
    mock.restore();
  }
});

test("an answer that carries no usage is a failure, not a spend of zero", async () => {
  resetOpenRouterAccount();
  const mock = accountMock({ key: { data: { label: "sk-or-v1-..." } } });
  try {
    await refreshOpenRouterAccount("sk-or-test");
    expect(cachedOpenRouterAccount("sk-or-test")).toBeUndefined();
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
    expect(cachedOpenRouterAccount("sk-or-test")?.usageUsd).toBe(12.5);
  } finally {
    mock.restore();
  }
});

/**
 * The event that fills an idle status page in. It has to fire on the read and only on the read:
 * a cache answering a page redrawn on every call would push a phone twelve reports an hour for
 * figures that never moved.
 */
test("a reading announces itself, and a cache hit and a failure announce nothing", async () => {
  resetOpenRouterAccount();
  const seen: string[] = [];
  const listener = ({ provider }: { provider: string }): void => void seen.push(provider);
  hooks.on("llm:account:refreshed", listener);
  const ok = accountMock();
  try {
    await refreshOpenRouterAccount("sk-or-test");
    expect(seen).toEqual(["openrouter.ai"]);

    // What a report calls, and what a fresh cache answers: no read, so nothing moved and nothing
    // is announced. This is the guard against an idle page being woken every five minutes.
    warmOpenRouterAccount("sk-or-test");
    expect(ok.calls).toHaveLength(2);
    expect(seen).toEqual(["openrouter.ai"]);
  } finally {
    ok.restore();
  }

  setSystemTime(new Date(Date.now() + 5 * 60_000 + 1));
  const down = accountMock({ keyStatus: 403 });
  try {
    await refreshOpenRouterAccount("sk-or-test");
    // A failure is not a reading: the page keeps the line it already has rather than being woken
    // to be told the same thing.
    expect(seen).toEqual(["openrouter.ai"]);
  } finally {
    setSystemTime();
    down.restore();
  }

  // The moment that matters: a cached "not reached" becoming a real figure.
  resetOpenRouterAccount();
  const back = accountMock();
  try {
    await refreshOpenRouterAccount("sk-or-test");
    expect(seen).toEqual(["openrouter.ai", "openrouter.ai"]);
  } finally {
    back.restore();
    hooks.off("llm:account:refreshed", listener);
  }
});
