/**
 * The summarizer walks the chain the session is on.
 *
 * It used to resolve one model and call it once: a tag whose first account was out of quota turned
 * every compaction into an HTTP 429 while the second account sat idle, where the same run would
 * have answered on it (measured 2026-11-02, error `HTTP 429 -- You've exceeded your subscription
 * rate limits` on a two-account tag). A run walks `providerFallbackTargets` on a provider failure;
 * a compaction is the same call and takes the same walk, on the same list.
 */

import { test, afterEach } from "bun:test";
import assert from "node:assert/strict";
import { compactSession } from "../../src/sessions/compaction.ts";
import { mockFetch } from "../helpers/mock-fetch.ts";
import { sseFromCompletion, sseResponse } from "../helpers/sse.ts";
import { saveSessionWithLog, type SessionLogSetup } from "../helpers/session-log.ts";
import type { MyClawConfig } from "../../src/core/config.ts";
import type { LegacySessionData } from "../../src/sessions/store.ts";

let logSetup: SessionLogSetup | undefined;

afterEach(async () => {
  await logSetup?.cleanup();
  logSetup = undefined;
});

const SESSION_ID = "my-claw-app/thread/neras/compact-route";

function config(): MyClawConfig {
  return {
    whitelist: [], blacklist: [], channels: {},
    llm: {
      // Two plain OpenAI-compatible endpoints: the route is what is under test, not a subscription
      // sign-in a unit test cannot produce.
      providers: {
        alpha: { baseUrl: "https://alpha.local/v1" },
        beta: { baseUrl: "https://beta.local/v1" },
      },
      models: [
        { id: "alpha-1", label: "Alpha", provider: "alpha" },
        { id: "beta-1", label: "Beta", provider: "beta" },
      ],
      defaultProvider: "beta",
      defaultModel: "beta-1",
      providerRetry: { delaysMs: [1] },
    },
    agents: {},
    tags: { TwoAccounts: { route: [{ model: "alpha-1" }, { model: "beta-1" }] } },
    // A handful of short entries: the default verbatim tail would swallow the whole fixture.
    context: { autoCompact: { tailTokens: 40 } },
  } as unknown as MyClawConfig;
}

const SUMMARY = `1. What the owner asked 2. What was built ${"and the rest of it ".repeat(5)}`;

function sessionWithLog(quotaRetry?: boolean): Promise<LegacySessionData> {
  const now = new Date().toISOString();
  const data: LegacySessionData = {
    id: SESSION_ID,
    platform: "my-claw-app",
    chatType: "dm",
    createdAt: now,
    lastActiveAt: now,
    messages: [],
    modelOverride: "tag:TwoAccounts",
    ...(quotaRetry ? { quotaRetry: { enabled: true } } : {}),
  };
  return (async () => {
    logSetup = await saveSessionWithLog(SESSION_ID, data);
    for (let i = 0; i < 14; i++) {
      if (i % 2 === 0) logSetup.log.append({ type: "user", prompt: true, text: `turn ${i} ${"filler ".repeat(20)}` });
      else logSetup.log.append({ type: "phase", prompt: true, text: `turn ${i} ${"filler ".repeat(20)}`, runId: `r${i}` });
    }
    await logSetup.log.flush();
    return data;
  })();
}

function modelOf(init: RequestInit | undefined): string {
  const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
  return body.model ?? "unknown";
}

function spentPlan(): Response {
  return new Response(
    JSON.stringify({ error: { type: "usage_limit_reached", message: "The usage limit has been reached" } }),
    { status: 429, headers: { "Content-Type": "application/json" } },
  );
}

test("a tag whose first account is spent is summarized on its second", async () => {
  const models: string[] = [];
  const mock = mockFetch(async (_input, init) => {
    const model = modelOf(init);
    models.push(model);
    if (model === "alpha-1") return spentPlan();
    return sseFromCompletion({ choices: [{ message: { content: SUMMARY } }], usage: {} });
  });
  try {
    const result = await compactSession(config(), await sessionWithLog());
    assert.equal(result.ok, true, result.reason);
    assert.deepEqual(models, ["alpha-1", "beta-1"], "one request to the wall, then the next account");
  } finally {
    mock.restore();
  }
});

/**
 * The switch outranks the chain, exactly as it does for a run: a conversation that asked to wait
 * out its walls does not quietly answer on another account. The pass hands the failure back with
 * `retryableQuota`, and the channel queues the compaction on the wait.
 */
test("with the quota switch on, a wall stops the chain instead of borrowing another account", async () => {
  const models: string[] = [];
  const mock = mockFetch(async (_input, init) => {
    models.push(modelOf(init));
    return spentPlan();
  });
  try {
    const result = await compactSession(config(), await sessionWithLog(true));
    assert.equal(result.ok, false);
    assert.equal(result.retryableQuota, true);
    assert.match(result.reason ?? "", /Compaction error/);
    assert.deepEqual(models, ["alpha-1"]);
  } finally {
    mock.restore();
  }
});

/** A model that answered badly is not a provider failure: another model would write the same absence. */
test("an empty summary does not walk the route", async () => {
  const models: string[] = [];
  const mock = mockFetch(async (_input, init) => {
    models.push(modelOf(init));
    return sseResponse("");
  });
  try {
    const result = await compactSession(config(), await sessionWithLog());
    assert.equal(result.ok, false);
    assert.ok(!models.includes("beta-1"), `the route must not be walked: ${models.join(",")}`);
  } finally {
    mock.restore();
  }
});
