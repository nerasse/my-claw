/**
 * The Claude subscription's own usage endpoint, the one Claude Code's `/usage` reads.
 *
 * Undocumented, so every field is optional here and an unknown shape is a failure rather than a
 * crash. The client User-Agent is not decoration: the endpoint rate-limits an unknown caller into
 * a persistent 429, which then looks exactly like a spent quota.
 */
import { claudeUserAgent } from "../anthropic-release.ts";
import { getJson, isAuthFailure } from "./http.ts";
import { clampPercent, isoOf, numberOf, recordOf, stringOf, type QuotaProbe, type QuotaWindow } from "./types.ts";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

function labelFor(kind: string, scope: string | undefined): string {
  if (kind === "session") return "5 h";
  if (kind === "weekly_all") return "Week";
  if (kind === "weekly_scoped") return scope ? `${scope} week` : "Week";
  return kind.replaceAll("_", " ");
}

function windowOf(entry: Record<string, unknown>, fallbackId: string): QuotaWindow | undefined {
  const percent = numberOf(entry.percent) ?? numberOf(entry.utilization);
  if (percent === undefined) return undefined;
  const kind = stringOf(entry.kind) ?? fallbackId;
  const scope = stringOf(entry.scope);
  const windowSeconds = numberOf(entry.window_seconds);
  const resetAt = isoOf(entry.resets_at);
  return {
    id: scope ? `${kind}:${scope}` : kind,
    label: labelFor(kind, scope),
    usedPercent: clampPercent(percent),
    ...(resetAt ? { resetAt } : {}),
    ...(windowSeconds === undefined ? {} : { windowSeconds }),
  };
}

export async function claudeQuota(provider: string, token: string): Promise<QuotaProbe> {
  const response = await getJson(USAGE_URL, {
    authorization: `Bearer ${token}`,
    "anthropic-beta": "oauth-2025-04-20",
    "user-agent": claudeUserAgent(),
  });
  if (!response.ok) {
    return {
      ok: false,
      code: response.status === 429 ? "rate-limited" : isAuthFailure(response.status) ? "sign-in-expired" : "failed",
      message: response.message,
      ...(response.retryAfterMs === undefined ? {} : { retryAfterMs: response.retryAfterMs }),
    };
  }

  const body = recordOf(response.data);
  if (!body) return { ok: false, code: "failed", message: "unexpected response" };

  const windows: QuotaWindow[] = [];
  if (Array.isArray(body.limits)) {
    for (const entry of body.limits) {
      const record = recordOf(entry);
      const window = record ? windowOf(record, "window") : undefined;
      if (window) windows.push(window);
    }
  }
  // An older shape, and the one every community tool started from.
  for (const [key, id] of [["five_hour", "session"], ["seven_day", "weekly_all"]] as const) {
    if (windows.some((window) => window.id === id)) continue;
    const record = recordOf(body[key]);
    const window = record ? windowOf(record, id) : undefined;
    if (window) windows.push({ ...window, id, label: id === "session" ? "5 h" : "Week" });
  }

  const extra = recordOf(body.extra_usage);
  if (extra?.is_enabled === true) {
    const percent = numberOf(extra.utilization);
    if (percent !== undefined) {
      windows.push({ id: "extra", label: "Extra usage", usedPercent: clampPercent(percent) });
    }
  }

  if (windows.length === 0) return { ok: false, code: "failed", message: "unexpected response" };
  return {
    ok: true,
    snapshot: {
      provider,
      source: "claude",
      windows,
      balances: [],
      extras: [],
      fetchedAt: new Date().toISOString(),
    },
  };
}
