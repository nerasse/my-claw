/**
 * What each usage endpoint actually answers, and what the cache does with a failure.
 *
 * The fixtures are captured responses with the identifying fields blanked: the shapes are the
 * contract, and the contract is what these tests pin. A provider changing its shape must fail a
 * test here rather than draw a wrong bar on a page.
 */

import { beforeEach, test } from "bun:test";
import assert from "node:assert/strict";
import { mockFetch } from "../helpers/mock-fetch.ts";
import { claudeQuota, consumeClaudeReset } from "../../src/llm/quota/claude.ts";
import { codexQuota, consumeCodexReset } from "../../src/llm/quota/codex.ts";
import { opencodeGoQuota } from "../../src/llm/quota/opencode-go.ts";
import { openrouterQuota } from "../../src/llm/quota/openrouter.ts";
import { quotaFor, quotaSourceOf, resetQuotaCache } from "../../src/llm/quota/index.ts";
import type { MyClawConfig } from "../../src/core/config.ts";

beforeEach(() => resetQuotaCache());

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function configWith(providers: Record<string, unknown>): MyClawConfig {
  return { llm: { providers } } as unknown as MyClawConfig;
}

const CLAUDE_BODY = {
  five_hour: { utilization: 100, resets_at: "2026-10-23T00:29:59.918430+00:00" },
  seven_day: { utilization: 58, resets_at: "2026-10-24T05:59:59.918458+00:00" },
  seven_day_opus: null,
  seven_day_sonnet: null,
  extra_usage: { is_enabled: false, utilization: null },
  limits: [
    { kind: "session", group: "session", percent: 100, severity: "critical", resets_at: "2026-10-23T00:30:00.036679+00:00", scope: null },
    { kind: "weekly_all", group: "weekly", percent: 58, severity: "normal", resets_at: "2026-10-24T06:00:00.036749+00:00", scope: null },
    {
      kind: "weekly_scoped",
      group: "weekly",
      percent: 0,
      severity: "normal",
      resets_at: "2026-10-24T06:00:00+00:00",
      scope: { model: { id: null, display_name: "Fable" }, surface: null },
    },
  ],
};

const CODEX_BODY = {
  plan_type: "plus",
  email: "someone@example.com",
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: { used_percent: 58, limit_window_seconds: 18000, reset_after_seconds: 15163, reset_at: 1792725465 },
    secondary_window: { used_percent: 26, limit_window_seconds: 604800, reset_after_seconds: 583870, reset_at: 1793294171 },
  },
  credits: { has_credits: false, unlimited: false, balance: "0" },
  rate_limit_reset_credits: { available_count: 2, applicable_available_count: 0 },
};

const OPENCODE_GO_BODY = {
  usage: {
    rolling: { status: "ok", percent: 1, resetsAt: "2026-10-23T01:33:54.000Z" },
    weekly: { status: "ok", percent: 57, resetsAt: "2026-10-26T00:00:00.000Z" },
    monthly: { status: "ok", percent: 79, resetsAt: "2026-11-02T00:09:03.000Z" },
  },
};

test("claude reads the modern limits array", async () => {
  const mock = mockFetch(async () => json(CLAUDE_BODY));
  try {
    const result = await claudeQuota("claude-2", "token");
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.snapshot.windows.map((w) => [w.id, w.label, w.usedPercent]), [
      ["session", "5 h", 100],
      ["weekly_all", "Week · all models", 58],
      ["weekly_scoped:Fable", "Week · Fable", 0],
    ]);
    assert.equal(result.snapshot.windows[0]?.resetAt, "2026-10-23T00:30:00.036Z");
  } finally {
    mock.restore();
  }
});

test("claude falls back to five_hour and seven_day when limits is absent", async () => {
  const { limits: _limits, ...legacy } = CLAUDE_BODY;
  const mock = mockFetch(async () => json(legacy));
  try {
    const result = await claudeQuota("claude-2", "token");
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.snapshot.windows.map((w) => [w.id, w.label, w.usedPercent]), [
      ["session", "5 h", 100],
      ["weekly_all", "Week · all models", 58],
    ]);
  } finally {
    mock.restore();
  }
});

test("claude says the sign-in expired on a 401 and honours Retry-After on a 429", async () => {
  let mock = mockFetch(async () => json({ error: "unauthorized" }, 401));
  try {
    const refused = await claudeQuota("claude-2", "token");
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.equal(refused.code, "sign-in-expired");
  } finally {
    mock.restore();
  }

  mock = mockFetch(async () => json({ error: "slow down" }, 429, { "retry-after": "120" }));
  try {
    const limited = await claudeQuota("claude-2", "token");
    assert.equal(limited.ok, false);
    if (!limited.ok) {
      assert.equal(limited.code, "rate-limited");
      assert.equal(limited.retryAfterMs, 120_000);
    }
  } finally {
    mock.restore();
  }
});

test("codex identifies its windows by duration, not by slot", async () => {
  const swapped = {
    ...CODEX_BODY,
    rate_limit: {
      primary_window: { used_percent: 26, limit_window_seconds: 604800, reset_at: 1793294171 },
      secondary_window: { used_percent: 58, limit_window_seconds: 18000, reset_at: 1792725465 },
    },
  };
  const mock = mockFetch(async () => json(swapped));
  try {
    const result = await codexQuota("chatgpt", { accessToken: "tok", accountId: "acc" });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.snapshot.windows.map((w) => [w.label, w.usedPercent]), [
      ["Week", 26],
      ["5 h", 58],
    ]);
    assert.equal(result.snapshot.resets?.available, 2);
  } finally {
    mock.restore();
  }
});

test("opencode go reads its three windows as published", async () => {
  const mock = mockFetch(async () => json(OPENCODE_GO_BODY));
  try {
    const result = await opencodeGoQuota("opencode_go", "key");
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.snapshot.windows.map((w) => [w.id, w.usedPercent, w.resetAt]), [
      ["rolling", 1, "2026-10-23T01:33:54.000Z"],
      ["weekly", 57, "2026-10-26T00:00:00.000Z"],
      ["monthly", 79, "2026-11-02T00:09:03.000Z"],
    ]);
  } finally {
    mock.restore();
  }
});

test("opencode go takes the email only from a single-member workspace", async () => {
  const mock = mockFetch(async (input) =>
    String(input).endsWith("/budgets/members")
      ? json([{ email: "someone@example.com" }])
      : json(OPENCODE_GO_BODY),
  );
  try {
    const result = await opencodeGoQuota("opencode_go", "key");
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.snapshot.email, "someone@example.com");
  } finally {
    mock.restore();
  }

  const shared = mockFetch(async (input) =>
    String(input).endsWith("/budgets/members")
      ? json([{ email: "a@example.com" }, { email: "b@example.com" }])
      : json(OPENCODE_GO_BODY),
  );
  try {
    const result = await opencodeGoQuota("opencode_go", "key");
    assert.equal(result.ok, true);
    // The key does not say which member it is, and guessing would name the wrong account.
    if (result.ok) assert.equal(result.snapshot.email, undefined);
  } finally {
    shared.restore();
  }
});

test("openrouter pairs the wallet with the key, and survives a missing credits endpoint", async () => {
  const mock = mockFetch(async (input) => {
    const url = String(input);
    if (url.endsWith("/key")) {
      return json({ data: { label: "main", usage: 13.4, usage_weekly: 0.85, usage_monthly: 0.86, limit: null } });
    }
    return json({ data: { total_credits: 50, total_usage: 49.97 } });
  });
  try {
    const result = await openrouterQuota("openrouter", "key");
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.snapshot.balances, [
      { id: "credits", label: "Credits", currency: "USD", remaining: 0.03, total: 50 },
    ]);
  } finally {
    mock.restore();
  }

  const onlyKey = mockFetch(async (input) =>
    String(input).endsWith("/key") ? json({ data: { usage: 1 } }) : json({ error: "no" }, 403),
  );
  try {
    const result = await openrouterQuota("openrouter", "key");
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.snapshot.balances.length, 0);
  } finally {
    onlyKey.restore();
  }
});

test("a provider with no usage API is a no-source answer, not an error path", async () => {
  const config = configWith({ groq: { type: "openai", baseUrl: "https://api.groq.com/openai/v1", apiKeyEnv: "GROQ_API_KEY" } });
  assert.equal(quotaSourceOf(config.llm.providers?.["groq"]), undefined);
  const result = await quotaFor(config, "groq");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "no-source");
});

test("an account with no credential says so without a request", async () => {
  const config = configWith({ "claude-none": { type: "anthropic" } });
  const mock = mockFetch(async () => {
    throw new Error("no request expected");
  });
  try {
    const result = await quotaFor(config, "claude-none");
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "not-signed-in");
  } finally {
    mock.restore();
  }
});

test("the cache serves the snapshot, force bypasses it, and a 429 keeps the last good one", async () => {
  let calls = 0;
  let limited = false;
  const mock = mockFetch(async (input) => {
    calls += 1;
    if (limited) return json({ error: "slow down" }, 429, { "retry-after": "600" });
    if (String(input).endsWith("/key")) return json({ data: { usage: 2 } });
    return json({ data: { total_credits: 10, total_usage: 4 } });
  });
  const config = configWith({ openrouter: { baseUrl: "https://openrouter.ai/api/v1", apiKeyEnv: "QUOTA_TEST_OPENROUTER_KEY" } });
  process.env["QUOTA_TEST_OPENROUTER_KEY"] = "k";
  try {
    const first = await quotaFor(config, "openrouter");
    assert.equal(first.ok, true);
    const afterFirst = calls;

    const cached = await quotaFor(config, "openrouter");
    assert.equal(cached.ok, true);
    assert.equal(calls, afterFirst);

    await quotaFor(config, "openrouter", { force: true });
    assert.equal(calls, afterFirst + 2);

    limited = true;
    const stale = await quotaFor(config, "openrouter", { force: true });
    assert.equal(stale.ok, true);
    if (stale.ok) assert.equal(stale.stale, true);

    const cooled = calls;
    const duringCooldown = await quotaFor(config, "openrouter", { force: true });
    assert.equal(duringCooldown.ok, true);
    if (duringCooldown.ok) assert.equal(duringCooldown.stale, true);
    assert.equal(calls, cooled);
  } finally {
    mock.restore();
    delete process.env["QUOTA_TEST_OPENROUTER_KEY"];
  }
});

test("codex lists the banked credits with the soonest expiry", async () => {
  const mock = mockFetch(async (input) => {
    if (String(input).endsWith("/rate-limit-reset-credits")) {
      return json({
        credits: [
          { id: "late", status: "available", expires_at: "2026-12-01T00:00:00Z" },
          { id: "soon", status: "available", expires_at: "2026-10-29T00:00:00Z" },
          { id: "gone", status: "redeemed", expires_at: "2026-10-01T00:00:00Z" },
        ],
        available_count: 2,
      });
    }
    return json(CODEX_BODY);
  });
  try {
    const result = await codexQuota("chatgpt", { accessToken: "tok", accountId: "acc" });
    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual(result.snapshot.resets, { available: 2, nextExpiresAt: "2026-10-29T00:00:00.000Z" });
  } finally {
    mock.restore();
  }
});

test("codex spends the soonest-expiring credit, with one request id", async () => {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  const mock = mockFetch(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method, ...(typeof init?.body === "string" ? { body: init.body } : {}) });
    if (url.endsWith("/rate-limit-reset-credits") && method === "GET") {
      return json({
        credits: [
          { id: "late", status: "available", expires_at: "2026-12-01T00:00:00Z" },
          { id: "soon", status: "available", expires_at: "2026-10-29T00:00:00Z" },
        ],
        available_count: 2,
      });
    }
    if (url.endsWith("/consume")) return json({ code: "reset", windows_reset: 1 });
    return json({});
  });
  try {
    const result = await consumeCodexReset("chatgpt", { accessToken: "tok", accountId: "acc" });
    assert.equal(result.ok, true);
    const post = calls.find((call) => call.method === "POST");
    assert.ok(post);
    const body = JSON.parse(post.body ?? "{}") as { credit_id?: string; redeem_request_id?: string };
    assert.equal(body.credit_id, "soon");
    assert.match(body.redeem_request_id ?? "", /^[0-9a-f-]{36}$/);
  } finally {
    mock.restore();
  }
});

test("codex says why a reset was refused, and does not invent a second credit", async () => {
  const mock = mockFetch(async (input, init) => {
    const url = String(input);
    if (url.endsWith("/rate-limit-reset-credits") && (init?.method ?? "GET") === "GET") {
      return json({ credits: [{ id: "only", status: "available", expires_at: "2026-10-29T00:00:00Z" }] });
    }
    return json({ detail: { code: "rate_limit_reset_ineligible" } }, 403);
  });
  try {
    const result = await consumeCodexReset("chatgpt", { accessToken: "tok", accountId: "acc" });
    assert.equal(result.ok, false);
    assert.equal(result.code, "ineligible");
    assert.match(result.message, /no window is full/i);
  } finally {
    mock.restore();
  }

  const none = mockFetch(async () => json({ credits: [{ id: "used", status: "redeemed" }] }));
  try {
    const result = await consumeCodexReset("chatgpt", { accessToken: "tok", accountId: "acc" });
    assert.equal(result.ok, false);
    assert.equal(result.code, "no-credit");
  } finally {
    none.restore();
  }
});

const CEDAR = {
  eligible: true,
  ineligible_reason: null,
  at_limit: true,
  grants: [
    {
      id: "grant_1",
      label: "Full reset (Weekly + 5 hr)",
      resets_total: 1,
      resets_left: 1,
      starts_at: null,
      ends_at: "2026-10-29T00:00:00Z",
      clears: ["five_hour", "seven_day"],
      paused: false,
      usable_now: true,
      use_requires_limit: true,
    },
  ],
  next_grant_id: "grant_1",
  cooldown_until: null,
};

test("claude reports its saved resets, and whether a claim would be accepted", async () => {
  const mock = mockFetch(async () => json({ ...CLAUDE_BODY, cedar_ember: CEDAR }));
  try {
    const result = await claudeQuota("claude-2", "token");
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(result.snapshot.resets, {
        available: 1,
        nextExpiresAt: "2026-10-29T00:00:00.000Z",
        clears: "5 h + weekly",
      });
    }
  } finally {
    mock.restore();
  }
});

test("claude has no reset when the inventory has no grant", async () => {
  const mock = mockFetch(async () => json({ ...CLAUDE_BODY, cedar_ember: { eligible: false, ineligible_reason: "no_grant", at_limit: false, grants: [] } }));
  try {
    const result = await claudeQuota("claude-2", "token");
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.snapshot.resets, undefined);
  } finally {
    mock.restore();
  }
});

test("claude spends the grant the provider names, against its organization", async () => {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  const mock = mockFetch(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method, ...(typeof init?.body === "string" ? { body: init.body } : {}) });
    if (url.endsWith("/profile")) return json({ organization: { uuid: "11111111-2222-3333-4444-555555555555" } });
    if (url.includes("cedar_ember=1")) return json({ ...CLAUDE_BODY, cedar_ember: CEDAR });
    if (url.endsWith("/reset_rate_limits")) return json({ result: "reset", resets_left: 0, cleared: ["five_hour", "seven_day"] });
    return json({});
  });
  try {
    const result = await consumeClaudeReset("token");
    assert.equal(result.ok, true);
    const post = calls.find((call) => call.method === "POST");
    assert.ok(post);
    assert.match(post.url, /\/api\/organizations\/11111111-2222-3333-4444-555555555555\/reset_rate_limits$/);
    const body = JSON.parse(post.body ?? "{}") as { program?: string; grant_id?: string; request_id?: string };
    assert.equal(body.program, "cedar_ember");
    assert.equal(body.grant_id, "grant_1");
    assert.match(body.request_id ?? "", /^[0-9a-f-]{36}$/);
  } finally {
    mock.restore();
  }
});

test("claude never retries a claim whose answer was unreadable", async () => {
  const mock = mockFetch(async (input, init) => {
    const url = String(input);
    if (url.endsWith("/profile")) return json({ organization: { uuid: "11111111-2222-3333-4444-555555555555" } });
    if (url.includes("cedar_ember=1")) return json({ ...CLAUDE_BODY, cedar_ember: CEDAR });
    return json({ error: "server_error" }, 500);
  });
  try {
    const result = await consumeClaudeReset("token");
    assert.equal(result.ok, false);
    assert.equal(result.code, "unknown");
    assert.match(result.message, /may or may not/);
  } finally {
    mock.restore();
  }
});
