/**
 * What each provider says is left, as a tool.
 *
 * The app has the same numbers on its provider pages, and the orchestrator had no way to read them:
 * a parent deciding whether to wait, spend a banked reset, or move a task to another account was
 * choosing blind, and a `blocked` sub-agent report could name a re-opening time without anything
 * able to confirm it had arrived.
 *
 * Read-only by design, and `force: false` by default. The adapter's page asks with `force` when the
 * owner presses refresh; a model that probed on every turn would burn requests to answer a question
 * it could have answered from the cache -- and on a provider whose usage endpoint is rate limited,
 * a probe has a cost of its own. The module's own TTL is what decides freshness, and both surfaces
 * share that cache, so a page the owner has open keeps the tool's answers free.
 *
 * It invents nothing: a provider that publishes no usage endpoint answers `no-source`, one that
 * does not name a remaining time yields `resetAt` absent. `docs/quota.md`.
 */

import { type Tool, type ToolResult, str, bool } from "./types.ts";
import { quotaFor, quotaSourceOf } from "../llm/quota/index.ts";
import { quotaWaitFrom } from "../llm/quota/retry.ts";
import type { QuotaOutcome, QuotaWindow } from "../llm/quota/types.ts";
import type { MyClawConfig } from "../core/config.ts";

/** The providers of an install, in declaration order: what `all` walks. */
function providerKeys(config: MyClawConfig): string[] {
  return Object.keys(config.llm?.providers ?? {});
}

function windowLine(window: QuotaWindow): string {
  const reset = window.resetAt ? `, resets ${window.resetAt}` : "";
  const span = window.windowSeconds ? `, window ${Math.round(window.windowSeconds / 3600)}h` : "";
  return `${window.label}: ${window.usedPercent}% used${span}${reset}`;
}

function describeOutcome(provider: string, outcome: QuotaOutcome): string {
  if (!outcome.ok) {
    return `- ${provider}: unavailable (${outcome.code}) ${outcome.message}`;
  }
  const snapshot = outcome.snapshot;
  const header = `- ${provider}: ${snapshot.source}${snapshot.plan ? ` (${snapshot.plan})` : ""}${snapshot.email ? ` as ${snapshot.email}` : ""}${outcome.stale ? " [cached, a fresh read failed]" : ""}, read ${snapshot.fetchedAt}`;
  const lines = [header];
  for (const window of snapshot.windows) lines.push(`    ${windowLine(window)}`);
  for (const balance of snapshot.balances) {
    const money = balance.remaining !== undefined
      ? `${balance.remaining}${balance.currency ? ` ${balance.currency}` : ""} left`
      : balance.count !== undefined ? `${balance.count} left` : "unknown";
    lines.push(`    ${balance.label}: ${money}`);
  }
  if (snapshot.resets) {
    const expiry = snapshot.resets.nextExpiresAt ? `, next expires ${snapshot.resets.nextExpiresAt}` : "";
    const clears = snapshot.resets.clears ? `, clears ${snapshot.resets.clears}` : "";
    lines.push(`    banked resets: ${snapshot.resets.available}${expiry}${clears}`);
  }
  for (const extra of snapshot.extras) lines.push(`    ${extra.label}: ${extra.value}`);
  // The one number a caller acts on. Read off the shared function so the tool, the retry and the
  // app's pill cannot disagree about when a spent plan comes back.
  const wait = quotaWaitFrom(outcome);
  lines.push(wait
    ? `    spent: the earliest reset it published is ${wait.at} (${wait.windows.join(", ")})`
    : "    nothing spent on a window that names a reset");
  return lines.join("\n");
}

export function createQuotaTool(config: MyClawConfig): Tool {
  return {
    name: "quota",
    description:
      "What each provider says is left on its plan: used percentages per window, balances, banked resets, " +
      "and when a spent window reopens. Read-only. Answers from a short-lived cache unless force is set: a " +
      "probe costs a request, and a page the owner has open shares the same cache. A provider that publishes " +
      "no usage endpoint says so instead of guessing.",
    parameters: {
      type: "object",
      properties: {
        provider: {
          type: "string",
          description: "One provider key from llm.providers. Omit for every provider that publishes usage.",
        },
        force: {
          type: "boolean",
          description: "Read the provider now instead of answering from the cache. Use when the owner says an account just changed.",
        },
      },
      required: [],
    },
    async execute(args): Promise<ToolResult> {
      const asked = str(args, "provider").trim();
      const force = bool(args, "force", false);
      const known = providerKeys(config);
      if (asked && !known.includes(asked)) {
        return {
          success: false,
          output: "",
          error: `Unknown provider "${asked}". Configured: ${known.join(", ") || "none"}.`,
        };
      }
      // `all` walks only the ones that publish an endpoint: listing every key-based provider as
      // "no-source" is noise the caller cannot act on.
      const targets = asked ? [asked] : known.filter((key) => quotaSourceOf(config.llm.providers?.[key]) !== undefined);
      if (targets.length === 0) {
        return { success: true, output: "No configured provider publishes a usage endpoint." };
      }
      const lines: string[] = [];
      for (const provider of targets) {
        const outcome = await quotaFor(config, provider, { force });
        lines.push(describeOutcome(provider, outcome));
      }
      return { success: true, output: lines.join("\n") };
    },
  };
}
