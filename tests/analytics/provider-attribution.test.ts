import { test, expect, beforeEach } from "bun:test";
import { analyticsDb, attributeCallsToProviders, recordApiCall } from "../../src/analytics/usage-db.ts";

/**
 * The calls recorded before each one named its provider, placed once by the address they reached.
 * Against the real recorder: the column has to exist on the table the writer fills.
 */

function call(baseUrl: string, providerKey?: string): void {
  recordApiCall({
    sessionId: "s",
    platform: "my-claw-app",
    model: "m",
    baseUrl,
    ...(providerKey === undefined ? {} : { providerKey }),
    streaming: false,
    caller: "orchestrator",
    promptTokens: 1,
    completionTokens: 1,
    totalTokens: 2,
    toolCalls: 0,
    iteration: 1,
    durationMs: 1,
  });
}

const keys = (): Array<[string, string | null]> =>
  (analyticsDb().prepare("SELECT base_url AS url, provider_key AS key FROM api_calls ORDER BY id").all() as Array<{ url: string; key: string | null }>).map((r) => [r.url, r.key]);

beforeEach(() => {
  analyticsDb().run("DELETE FROM api_calls");
  analyticsDb().run("PRAGMA user_version = 0");
});

test("a new call names the provider that served it", () => {
  call("https://openrouter.ai/api/v1", "work");
  expect(keys()).toEqual([["https://openrouter.ai/api/v1", "work"]]);
});

test("an old call goes to the one provider on its address, never to one of two, and a named call is left as it is", () => {
  call("https://opencode.ai/zen/go/v1");
  call("https://api.anthropic.com");
  call("claude-sdk");
  call("https://opencode.ai/zen/go/v1", "already");
  const attributed = attributeCallsToProviders({
    opencode_go: "https://opencode.ai/zen/go/v1",
    // A Claude plan and a Claude API key both reach this address: a guess would put one's spend on the other.
    anthropic: "https://api.anthropic.com",
    "claude-api": "https://api.anthropic.com",
    // A provider with no address of its own owns nothing.
    blank: "",
  });
  expect(attributed).toBe(1);
  expect(keys()).toEqual([
    ["https://opencode.ai/zen/go/v1", "opencode_go"],
    ["https://api.anthropic.com", null],
    ["claude-sdk", null],
    ["https://opencode.ai/zen/go/v1", "already"],
  ]);
});

test("once per database: a later config does not re-file the past", () => {
  call("https://openrouter.ai/api/v1");
  expect(attributeCallsToProviders({ openrouter: "https://openrouter.ai/api/v1", work: "https://openrouter.ai/api/v1" })).toBe(0);
  // The second account is gone from the config; the rows it made ambiguous stay unplaced.
  expect(attributeCallsToProviders({ openrouter: "https://openrouter.ai/api/v1" })).toBe(0);
  expect(keys()).toEqual([["https://openrouter.ai/api/v1", null]]);
});
