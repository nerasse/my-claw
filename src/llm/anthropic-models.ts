import type { EffortLevel } from "../core/config.ts";

const ANTHROPIC_BASE_URL = "https://api.anthropic.com";
const ANTHROPIC_VERSION = "2023-06-01";
const DISCOVER_TIMEOUT_MS = 15_000;

// Menu order, and the reference for normalizing whatever order the API reports.
const EFFORT_ORDER: EffortLevel[] = ["low", "medium", "high", "xhigh", "max", "ultra"];

export interface DiscoveredAnthropicModel {
  id: string;
  /** Display name without the "Claude" prefix, e.g. "Opus 4.8". */
  label: string;
  /** Version-less family name used as the submenu, e.g. "Opus". */
  family: string;
  effortLevels: EffortLevel[];
  vision: boolean;
  contextLimit?: number;
  outputLimit?: number;
}

interface AnthropicCapability {
  supported?: boolean;
}

interface AnthropicModelEntry {
  id?: string;
  display_name?: string;
  max_input_tokens?: number;
  max_tokens?: number;
  capabilities?: {
    effort?: AnthropicCapability & Record<string, unknown>;
    image_input?: AnthropicCapability;
  };
}

/**
 * Split "Claude Opus 4.8" into the label shown in menus and the family it belongs to. The
 * trailing token is the version, so everything before it names the family — that keeps the
 * grouping driven by the API instead of a hardcoded list of Claude families.
 */
export function splitAnthropicDisplayName(displayName: string, id: string): { label: string; family: string } {
  const cleaned = displayName.replace(/^claude\s+/i, "").trim();
  if (!cleaned) return { label: id, family: id };
  const parts = cleaned.split(/\s+/);
  const last = parts[parts.length - 1];
  const versioned = parts.length > 1 && last !== undefined && /^\d/.test(last);
  return { label: cleaned, family: versioned ? parts.slice(0, -1).join(" ") : cleaned };
}

/**
 * Per-model reasoning levels. The API reports them as one sub-object per level, and models do
 * differ (Opus 4.6 has no xhigh, Opus 4.1 has no effort at all), so a global list would offer
 * levels the model rejects.
 */
export function anthropicEffortLevels(effort: (AnthropicCapability & Record<string, unknown>) | undefined): EffortLevel[] {
  if (!effort?.supported) return [];
  return EFFORT_ORDER.filter((level) => {
    const entry = effort[level];
    return typeof entry === "object" && entry !== null && (entry as AnthropicCapability).supported === true;
  });
}

/**
 * List the versioned Claude models the account can run. The Claude Agent SDK only exposes
 * moving aliases (opus/sonnet/haiku), so this REST endpoint is the only way to pin a specific
 * version. The subscription OAuth token is accepted here — no separate API key needed.
 */
export async function fetchAnthropicModels(
  token: string,
  baseUrl: string = ANTHROPIC_BASE_URL,
): Promise<DiscoveredAnthropicModel[]> {
  const url = `${baseUrl.replace(/\/+$/, "")}/v1/models?limit=100`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DISCOVER_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${token}`, "anthropic-version": ANTHROPIC_VERSION },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { data?: AnthropicModelEntry[] };
    const out: DiscoveredAnthropicModel[] = [];
    for (const entry of body.data ?? []) {
      const id = entry.id;
      if (!id) continue;
      const { label, family } = splitAnthropicDisplayName(entry.display_name ?? "", id);
      out.push({
        id,
        label,
        family,
        effortLevels: anthropicEffortLevels(entry.capabilities?.effort),
        vision: entry.capabilities?.image_input?.supported === true,
        contextLimit: entry.max_input_tokens,
        outputLimit: entry.max_tokens,
      });
    }
    return out;
  } finally {
    clearTimeout(timer);
  }
}
