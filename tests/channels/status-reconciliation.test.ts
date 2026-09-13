import { test, expect, beforeEach } from "bun:test";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { MY_CLAW_DIR } from "../../src/core/config.ts";
import type { MyClawConfig } from "../../src/core/config.ts";
import type { LegacySessionData } from "../../src/sessions/store.ts";
import { getProviderModelUsage, recordApiCall } from "../../src/analytics/usage-db.ts";
import { ModelPricing, CACHE_VERSION, setSharedPricing } from "../../src/llm/pricing.ts";
import { statusReport } from "../../src/channels/status-command.ts";
import { refreshOpenRouterAccount } from "../../src/llm/openrouter-account.ts";
import { mockFetch } from "../helpers/mock-fetch.ts";
import { hooks } from "../../src/hooks/index.ts";
import { StatusWatch } from "../../src/channels/my-claw-app/status-watch.ts";
import type { MyClawAppUsageReconciliation } from "../../src/channels/my-claw-app/types.ts";

/**
 * The one line on the page that compares what we deduced with what a provider says it charged.
 *
 * Everything here runs against a mocked fetch: the figures come from a third party's ledger, and a
 * test that reached it would report a different number every day and none at all offline.
 */

const KEY_ENV = "TEST_RECONCILE_OR_KEY";

/**
 * models.dev, written to disk: OpenRouter rows are priced from the table like any other. `kimi`
 * moves between two calls of this helper the way a provider's tariff moves under a running
 * instance -- the file is overwritten in place and has no history.
 */
function pricing(kimi = 4): ModelPricing {
  mkdirSync(MY_CLAW_DIR, { recursive: true });
  writeFileSync(
    join(MY_CLAW_DIR, "model-pricing.json"),
    JSON.stringify({
      version: CACHE_VERSION,
      fetchedAt: new Date().toISOString(),
      hosts: { openrouter: "https://openrouter.ai/api/v1" },
      models: {
        openrouter: { "glm-5.2": { cost: { input: 1, output: 2 }, id: "glm-5.2" }, "kimi-k3": { cost: { input: kimi, output: 8 }, id: "kimi-k3" } },
      },
    }),
  );
  return new ModelPricing(() => ({}), () => []);
}

const config = {
  llm: {
    defaultModel: "claude-opus-5",
    models: [{ id: "claude-opus-5", label: "Opus 5", limit: { context: 1_000_000 } }],
    providers: { openrouter: { baseUrl: "https://openrouter.ai/api/v1", apiKeyEnv: KEY_ENV } },
  },
} as unknown as MyClawConfig;

/** The same config with no credential to read: the line has nothing to compare against. */
const keyless = { llm: { ...config.llm, providers: { openrouter: { baseUrl: "https://openrouter.ai/api/v1" } } } } as unknown as MyClawConfig;

function session(id: string): LegacySessionData {
  return {
    id,
    platform: "my-claw-app",
    chatType: "dm",
    createdAt: new Date(Date.now() - 3_600_000).toISOString(),
    lastActiveAt: new Date().toISOString(),
    messages: [{ role: "user", content: "hello", timestamp: new Date().toISOString() }],
  };
}

function call(sessionId: string, over: Partial<Parameters<typeof recordApiCall>[0]> = {}): void {
  recordApiCall({
    sessionId, parentSessionId: sessionId, platform: "my-claw-app", model: "glm-5.2",
    baseUrl: "https://openrouter.ai/api/v1", streaming: true, caller: "orchestrator",
    promptTokens: 1_000_000, completionTokens: 0, totalTokens: 1_000_000, toolCalls: 0, iteration: 1, durationMs: 10,
    ...over,
  });
}

/**
 * Both halves of this line are account-wide, so any row left by the previous test is this one's
 * noise. Cleared through a second connection: the module keeps its own handle and never reopens.
 */
beforeEach(() => {
  const db = new Database(join(MY_CLAW_DIR, "analytics.db"));
  try {
    db.run("DELETE FROM api_calls");
  } catch {
    // Nothing has recorded a call yet, so there is no table and nothing to clear.
  } finally {
    db.close();
  }
});

async function report(sessionId: string, over: { config?: MyClawConfig; kimi?: number } = {}) {
  return (await statusReport({ config: over.config ?? config, sessionId, session: session(sessionId), liveRuns: [], pricing: pricing(over.kimi) })).status;
}

/** `/key` and `/credits`, as the live routes answer them. */
function accountMock(usage: number, credits: { total: number; used: number } | null = { total: 20, used: 12.5 }) {
  return mockFetch(async (input) =>
    String(input).endsWith("/key")
      ? new Response(JSON.stringify({ data: { label: "sk-or-v1-...", limit: null, limit_remaining: null, usage, is_free_tier: false } }), { status: 200 })
      : credits === null
        ? new Response("{}", { status: 403 })
        : new Response(JSON.stringify({ data: { total_credits: credits.total, total_usage: credits.used } }), { status: 200 }),
  );
}

/** Warms the account cache so the report reads it without ever starting a fetch of its own. */
async function warmed(usage: number, credits?: { total: number; used: number } | null): Promise<void> {
  const mock = accountMock(usage, credits === undefined ? { total: 20, used: 12.5 } : credits);
  try {
    process.env[KEY_ENV] = "sk-or-test";
    await refreshOpenRouterAccount("sk-or-test");
  } finally {
    mock.restore();
  }
}

test("the provider answers: both figures, the gap between them, and what is left on the account", async () => {
  const sessionId = "my-claw-app/thread/o/reconciled";
  call(sessionId);
  call("my-claw-app/thread/o/another-chat");
  try {
    await warmed(12.5);
    const status = await report(sessionId);
    const r = status.reconciliation!;
    expect(r.provider).toBe("openrouter.ai");
    // Two conversations, one dollar of input each: the key is billed, not the chat, so both count.
    expect(r.recordedUsd).toBeCloseTo(2, 6);
    expect(r.calls).toBe(2);
    expect(r.providerUsd).toBe(12.5);
    expect(r.deltaUsd).toBeCloseTo(10.5, 6);
    expect(r.balanceUsd).toBeCloseTo(7.5, 6);
    expect(r.providerUnread).toBe(false);
    expect(r.windowDays).toBe(90);
  } finally {
    delete process.env[KEY_ENV];
  }
});

test("the provider is unreachable: the line stays, carrying our sum alone and saying so", async () => {
  const sessionId = "my-claw-app/thread/o/unreachable";
  call(sessionId);
  const mock = mockFetch(async () => new Response("{}", { status: 403 }));
  try {
    process.env[KEY_ENV] = "sk-or-test";
    // The failure is cached, so drawing the report reads it instead of starting a second attempt.
    await refreshOpenRouterAccount("sk-or-test");
    const r = (await report(sessionId)).reconciliation!;
    expect(r.providerUnread).toBe(true);
    expect(r.recordedUsd).toBeCloseTo(1, 6);
    expect(r.calls).toBe(1);
    // Half a comparison is not a comparison: no figure of theirs, no gap, no balance.
    expect(r.providerUsd).toBeUndefined();
    expect(r.deltaUsd).toBeUndefined();
    expect(r.balanceUsd).toBeUndefined();
  } finally {
    delete process.env[KEY_ENV];
    mock.restore();
  }
});

test("no row of ours: zero is a reading, and the whole of their figure is the gap", async () => {
  try {
    await warmed(12.5);
    const r = (await report("my-claw-app/thread/o/no-rows")).reconciliation!;
    expect(r.recordedUsd).toBe(0);
    expect(r.calls).toBe(0);
    expect(r.deltaUsd).toBeCloseTo(12.5, 6);
  } finally {
    delete process.env[KEY_ENV];
  }
});

test("no key to read: no line at all, rather than one number wearing the label of a comparison", async () => {
  call("my-claw-app/thread/o/keyless");
  const status = await report("my-claw-app/thread/o/keyless", { config: keyless });
  expect(status.reconciliation).toBeUndefined();
});

test("the sum is the money the page shows: frozen where it was frozen, priced live where it was not", async () => {
  const sessionId = "my-claw-app/thread/o/frozen";
  // Recorded while the table said 4 USD/M, so this row carries that figure forever.
  setSharedPricing(pricing(4));
  call(sessionId, { model: "kimi-k3" });
  setSharedPricing(null);
  // Recorded with no table at all: nothing was frozen, and the report prices it at today's rate.
  call(sessionId, { model: "glm-5.2" });
  try {
    await warmed(12.5);
    // The tariff has moved tenfold since. The frozen row must not move with it, or a provider
    // raising its price would restate every OpenRouter line of the last ninety days.
    const r = (await report(sessionId, { kimi: 40 })).reconciliation!;
    expect(r.recordedUsd).toBeCloseTo(5, 6);
    expect(r.calls).toBe(2);
  } finally {
    delete process.env[KEY_ENV];
  }
});

test("the analytics are asked for one endpoint, not for everything the page then throws away", () => {
  call("my-claw-app/thread/o/scan");
  call("my-claw-app/thread/o/scan", { model: "claude-opus-5", baseUrl: "https://api.anthropic.com" });
  // There is no index on base_url and no URL parser in SQLite, so the LIKE is a prefilter and the
  // host check above is the authority. The prefilter still has to filter: on the live database it
  // is the difference between scanning 45 000 rows into 50 groups and into 15.
  const rows = getProviderModelUsage("%openrouter.ai%");
  expect(rows.map((r) => r.baseUrl)).toEqual(["https://openrouter.ai/api/v1"]);
});

test("a host that merely mentions openrouter.ai in its path is not OpenRouter", async () => {
  const sessionId = "my-claw-app/thread/o/lookalike";
  call(sessionId, { baseUrl: "https://proxy.example.com/openrouter.ai/v1" });
  call(sessionId);
  try {
    await warmed(12.5);
    const r = (await report(sessionId)).reconciliation!;
    // The SQL LIKE catches both; the host check is what decides, so only the real one is counted.
    expect(r.calls).toBe(1);
    expect(r.recordedUsd).toBeCloseTo(1, 6);
  } finally {
    delete process.env[KEY_ENV];
  }
});

test("the report never waits on the provider: a call still in flight leaves the line unread", async () => {
  const sessionId = "my-claw-app/thread/o/no-wait";
  call(sessionId);
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const mock = mockFetch(async (input) => {
    await gate;
    return new Response(JSON.stringify(String(input).endsWith("/key") ? { data: { usage: 12.5 } } : { data: { total_credits: 20, total_usage: 12.5 } }), { status: 200 });
  });
  try {
    process.env[KEY_ENV] = "sk-or-test";
    const pending = refreshOpenRouterAccount("sk-or-test");
    // The report is drawn while that request hangs, and comes back with our half of the line.
    const r = (await report(sessionId)).reconciliation!;
    expect(r.providerUnread).toBe(true);
    expect(r.recordedUsd).toBeCloseTo(1, 6);
    release?.();
    await pending;
  } finally {
    delete process.env[KEY_ENV];
    mock.restore();
  }
});

/**
 * The whole point of the event, end to end: a page open on an idle conversation is told
 * "provider not reached", the background read lands, and the page is handed a report carrying
 * the figures without anybody touching the thread.
 *
 * `hooks.on` here is the line `src/index.ts` wires at boot, and `StatusWatch` is the real one.
 */
test("a ledger reading refills a page that was told the provider could not be reached", async () => {
  const sessionId = "my-claw-app/thread/o/refill";
  call(sessionId);
  const sent: MyClawAppUsageReconciliation[] = [];
  const watch = new StatusWatch({
    report: async (_owner, threadId) => (await statusReport({ config, sessionId: threadId, session: session(threadId), liveRuns: [], pricing: pricing() })).status,
    send: (_ws, frame) => {
      if (frame.status.reconciliation) sent.push(frame.status.reconciliation);
    },
    sessionOf: (_owner, threadId) => threadId,
    parentOf: async () => undefined,
    settleMs: 10,
  });
  const listener = (): void => watch.refreshed();
  hooks.on("llm:account:refreshed", listener);
  const mock = accountMock(12.5);
  try {
    process.env[KEY_ENV] = "sk-or-test";
    await watch.watch({ id: "ws" } as never, "o", sessionId);
    // Nothing has read the ledger yet, and the page was not made to wait for it.
    expect(sent).toHaveLength(1);
    expect(sent[0]!.providerUnread).toBe(true);

    await refreshOpenRouterAccount("sk-or-test");
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(sent).toHaveLength(2);
    expect(sent[1]!.providerUnread).toBe(false);
    expect(sent[1]!.providerUsd).toBe(12.5);
    expect(sent[1]!.deltaUsd).toBeCloseTo(11.5, 6);
  } finally {
    delete process.env[KEY_ENV];
    hooks.off("llm:account:refreshed", listener);
    mock.restore();
  }
});

/**
 * The chat surface gets one line and cannot be tapped, so the direction of the gap is spelled out
 * rather than signed: `+$10.50` next to a balance reads as a credit, which is its opposite.
 */
async function line(sessionId: string, over: { config?: MyClawConfig } = {}): Promise<string> {
  return (await statusReport({ config: over.config ?? config, sessionId, session: session(sessionId), liveRuns: [], pricing: pricing() })).text;
}

test("the chat line carries the balance and the gap, in words, on the line that already exists", async () => {
  const sessionId = "my-claw-app/thread/o/chat-line";
  call(sessionId);
  call(sessionId);
  try {
    await warmed(12.5);
    const text = await line(sessionId);
    expect(text).toContain("openrouter.ai: $7.50 left, billed $10.50 more than recorded");
    // One line, in the register of the ones beside it, and no second line hiding in it.
    expect(text.split(" \u00b7 ").length).toBeGreaterThan(2);
    expect(text).not.toContain("\n");
  } finally {
    delete process.env[KEY_ENV];
  }
});

test("a provider that billed less than we recorded is said to have billed less, not shown a minus", async () => {
  const sessionId = "my-claw-app/thread/o/chat-under";
  call(sessionId);
  call(sessionId);
  try {
    // A BYOK route: we record the upstream charge, OpenRouter never billed for it.
    await warmed(1.5, { total: 20, used: 1.5 });
    expect(await line(sessionId)).toContain("openrouter.ai: $18.50 left, billed $0.50 less than recorded");
  } finally {
    delete process.env[KEY_ENV];
  }
});

test("a gap too small to print is named as agreement rather than rounded to zero", async () => {
  const sessionId = "my-claw-app/thread/o/chat-tiny";
  call(sessionId);
  try {
    await warmed(1.001, { total: 20, used: 1.001 });
    expect(await line(sessionId)).toContain("openrouter.ai: $19.00 left, billed within $0.01 of recorded");
  } finally {
    delete process.env[KEY_ENV];
  }
});

test("no balance published leaves the gap standing alone, with no empty phrase before it", async () => {
  const sessionId = "my-claw-app/thread/o/chat-nobalance";
  call(sessionId);
  call(sessionId);
  try {
    await warmed(12.5, null);
    const text = await line(sessionId);
    expect(text).toContain("openrouter.ai: billed $10.50 more than recorded");
    expect(text).not.toContain("left,");
  } finally {
    delete process.env[KEY_ENV];
  }
});

test("a ledger that was not read says so, instead of a sentence built around a missing figure", async () => {
  const sessionId = "my-claw-app/thread/o/chat-unread";
  call(sessionId);
  const mock = mockFetch(async () => new Response("{}", { status: 403 }));
  try {
    process.env[KEY_ENV] = "sk-or-test";
    await refreshOpenRouterAccount("sk-or-test");
    const text = await line(sessionId);
    expect(text).toContain("openrouter.ai not reached");
    expect(text).not.toContain("left");
    expect(text).not.toContain("billed");
    expect(text).not.toContain("NaN");
    expect(text).not.toContain("undefined");
  } finally {
    delete process.env[KEY_ENV];
    mock.restore();
  }
});

test("no key, no segment: the chat line is exactly what it was before any of this", async () => {
  const sessionId = "my-claw-app/thread/o/chat-keyless";
  call(sessionId);
  const text = await line(sessionId, { config: keyless });
  expect(text).not.toContain("openrouter.ai");
  expect(text).toContain("Status: claude-opus-5");
});

test("nothing that identifies the key can reach the line or the payload", async () => {
  const sessionId = "my-claw-app/thread/o/chat-secret";
  call(sessionId);
  // The live `/key` answer carries a label and the key's limits. None of it is read, so none of it
  // can be echoed into a chat message or a log line that quotes one.
  const mock = mockFetch(async (input) =>
    String(input).endsWith("/key")
      ? new Response(JSON.stringify({ data: { label: "sk-or-v1-0123456789abcdef", limit: 50, limit_remaining: 37.5, usage: 12.5, is_free_tier: false } }), { status: 200 })
      : new Response(JSON.stringify({ data: { total_credits: 20, total_usage: 12.5 } }), { status: 200 }),
  );
  try {
    process.env[KEY_ENV] = "sk-or-test";
    await refreshOpenRouterAccount("sk-or-test");
    const { text, status } = await statusReport({ config, sessionId, session: session(sessionId), liveRuns: [], pricing: pricing() });
    const serialised = JSON.stringify(status);
    for (const secret of ["sk-or", "0123456789abcdef", "limit_remaining", "is_free_tier"]) {
      expect(text).not.toContain(secret);
      expect(serialised).not.toContain(secret);
    }
    // The figures that are on purpose are still there.
    expect(text).toContain("$7.50 left");
  } finally {
    delete process.env[KEY_ENV];
    mock.restore();
  }
});
