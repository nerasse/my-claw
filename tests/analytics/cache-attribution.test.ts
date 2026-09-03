import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { recordApiCall } from "../../src/analytics/usage-db.ts";
import { MY_CLAW_DIR } from "../../src/core/config.ts";
import { cacheAttributionOf } from "../../src/llm/cache-policy.ts";

// Against the real recorder, on the MY_CLAW_DIR that tests/setup.ts redirects to a temp dir. The
// sibling suite rebuilds the schema by hand, which cannot catch a column the writer forgot: an
// INSERT naming an absent column throws, and recordApiCall swallows its errors, so the failure
// mode is silence.
function rowsOf(sessionId: string): Array<Record<string, unknown>> {
  const db = new Database(join(MY_CLAW_DIR, "analytics.db"), { readonly: true });
  try {
    return db.prepare("SELECT * FROM api_calls WHERE session_id = ?").all(sessionId) as Array<Record<string, unknown>>;
  } finally {
    db.close();
  }
}

test("a recorded call names its transport and its cache dialect", () => {
  const sessionId = `attribution-${Date.now()}`;
  recordApiCall({
    sessionId,
    platform: "test",
    model: "gpt-5.6-luna",
    baseUrl: "https://chatgpt.com/backend-api",
    streaming: true,
    caller: "orchestrator",
    promptTokens: 100,
    completionTokens: 10,
    totalTokens: 110,
    cacheReadTokens: 90,
    toolCalls: 0,
    iteration: 1,
    durationMs: 5,
    ...cacheAttributionOf({ backend: "codex", model: "gpt-5.6-luna" }),
  });

  const rows = rowsOf(sessionId);
  expect(rows).toHaveLength(1);
  expect(rows[0]!["backend"]).toBe("codex");
  expect(rows[0]!["cache_dialect"]).toBe("openai");
  // The columns that motivated the change still land, so a cache audit no longer has to guess
  // the transport from the host.
  expect(rows[0]!["cache_read_tokens"]).toBe(90);
  expect(rows[0]!["prompt_tokens"]).toBe(100);
});

test("a call that names neither still records", () => {
  const sessionId = `attribution-null-${Date.now()}`;
  recordApiCall({
    sessionId,
    platform: "test",
    model: "deepseek/deepseek-v4-flash",
    baseUrl: "https://api.commandcode.ai/provider/v1",
    streaming: false,
    caller: "compaction",
    promptTokens: 1,
    completionTokens: 1,
    totalTokens: 2,
    toolCalls: 0,
    iteration: 0,
    durationMs: 1,
  });

  const rows = rowsOf(sessionId);
  expect(rows).toHaveLength(1);
  expect(rows[0]!["backend"]).toBeNull();
  expect(rows[0]!["cache_dialect"]).toBeNull();
});
