/**
 * What a run spent is what its whole tree spent: its sub-agents and the browser tasks they
 * delegated. The first-level sum left every browser task out of a cron run's cost (2026-09-28).
 */

import { expect, test } from "bun:test";
import { getDelegatedModelUsage, getTreeModelUsage, recordApiCall } from "../../src/analytics/usage-db.ts";

function call(sessionId: string, parentSessionId: string): void {
  recordApiCall({
    sessionId, parentSessionId, platform: "cron", model: "deepseek-v4.1-flash", baseUrl: "https://opencode.ai/zen/go/v1",
    streaming: false, caller: parentSessionId === sessionId ? "orchestrator" : "subagent",
    promptTokens: 100, completionTokens: 10, totalTokens: 110, toolCalls: 0, iteration: 1, durationMs: 5,
  });
}

test("every level under a run is counted, and only for this run", () => {
  const root = "cron/aaaaaaaaaaaa/1";
  call(root, root);
  call("subagent/volet-1", root);
  call("subagent/volet-1-browser", "subagent/volet-1");
  call("subagent/volet-1-browser", "subagent/volet-1");
  // A named sub-agent this run never drove: none of its spend is this run's.
  call("subagent/elsewhere", "my-claw-app/thread/neras/x");
  const sessions = getTreeModelUsage(root).map((r) => [r.sessionId, r.calls]).sort();
  expect(sessions).toEqual([["subagent/volet-1", 1], ["subagent/volet-1-browser", 2]]);
  // The first-level view it replaces for a run's cost, for the record.
  expect(getDelegatedModelUsage(root).map((r) => r.sessionId)).toEqual(["subagent/volet-1"]);
});
