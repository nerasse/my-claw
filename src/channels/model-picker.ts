import { createHash } from "node:crypto";
import type { ConfirmationButton } from "./types.ts";
import type { EffortLevel, LlmConfig } from "../core/config.ts";
import { effectiveEffort, effortOptionsFor, type EffectiveEffort } from "../llm/resolver.ts";

export interface ModelOption {
  id: string;
  label: string;
  // "/"-separated path; each segment is one submenu level (e.g. "Claude/Opus").
  group?: string;
  // Per-model supported effort levels (from SDK discovery). When present, the effort submenu
  // shows only these levels for this model; when absent, falls back to the global levels.
  supportedEffortLevels?: EffortLevel[];
  // Explicit `false` means the provider says this model has no reasoning effort at all, which is
  // different from "unknown" (undefined) where the global list is the best guess.
  supportsEffort?: boolean;
  // Whether effort actually reaches the provider for this model, resolved from the backend at
  // sync time. Distinct from `supportsEffort`: an OpenAI-compatible model the provider says
  // nothing about never gets the parameter sent, so offering levels for it is a no-op. Absent
  // means "not resolved" and leaves the older capability fields in charge.
  effortApplies?: boolean;
}

export interface EffortOptions {
  enabled: boolean;
  levels: EffortLevel[];
}

// A picker callback is a model selection, a submenu navigation step, or an effort change.
// keepEffort finalizes the chained model->effort flow without touching the session's effort.
export type PickerCallback =
  | { kind: "select"; modelId: string }
  | { kind: "openGroup"; groupPath: string }
  | { kind: "back" }
  | { kind: "openEffort" }
  | { kind: "setEffort"; level: EffortLevel }
  | { kind: "keepEffort" }
  // A picker button whose target no longer exists (menu left open across a discovery refresh).
  | { kind: "stale" };

const EFFORT_ACTION = "effm";
const KEEP_EFFORT_ACTION = "effk";

// Telegram caps callback_data at 64 bytes, so a menu cannot carry a model id verbatim: ids come
// from provider discovery and are unbounded. A fixed-width digest of the id fits the budget and,
// unlike a list position, still designates the same model after the list is reordered.
const REF_LENGTH = 12;

function refFor(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, REF_LENGTH);
}

/**
 * Map refs back to their values, widening the digest if two ever collide. A collision would
 * silently point a button at the wrong model, so uniqueness is enforced rather than assumed.
 */
function buildRefMap(values: readonly string[]): Map<string, string> {
  const unique = [...new Set(values)];
  for (let length = REF_LENGTH; length <= 64; length += 4) {
    const map = new Map(unique.map((value) => [createHash("sha256").update(value).digest("hex").slice(0, length), value]));
    if (map.size === unique.length) return map;
  }
  throw new Error("model picker: unresolvable ref collision");
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function mark(label: string, selected: boolean): string {
  return selected ? `${label} [selected]` : label;
}

function splitGroup(group?: string): string[] {
  return group ? group.split("/").map((s) => s.trim()).filter(Boolean) : [];
}

/**
 * Compact provider-first summary for /models: one line per top-level group with its model count
 * (+ a marker when the current model lives there), then any ungrouped models individually. Keeps
 * the reference short and points to the interactive /model menu instead of dumping every model.
 */
export function formatModelGroupSummary(
  models: readonly ModelOption[],
  currentModelId: string,
): string[] {
  const order: string[] = [];
  const counts = new Map<string, number>();
  const ungrouped: ModelOption[] = [];
  for (const m of models) {
    const top = splitGroup(m.group)[0];
    if (!top) {
      ungrouped.push(m);
      continue;
    }
    if (!order.includes(top)) order.push(top);
    counts.set(top, (counts.get(top) ?? 0) + 1);
  }

  const currentTop = splitGroup(models.find((m) => m.id === currentModelId)?.group)[0];
  const lines = order.map((group) => {
    const n = counts.get(group) ?? 0;
    return `- ${group}: ${n} model${n > 1 ? "s" : ""}${group === currentTop ? " (current here)" : ""}`;
  });
  for (const m of ungrouped) {
    lines.push(`- ${m.label}${m.id === currentModelId ? " [selected]" : ""}`);
  }
  return lines;
}

export class ModelPicker {
  constructor(
    private models: ModelOption[],
    private effort: EffortOptions = { enabled: false, levels: [] },
  ) {}

  /** Replace the model list at runtime (used by the config hot-reload watcher). */
  setModels(models: ModelOption[]): void {
    this.models = models;
  }

  setEffortOptions(effort: EffortOptions): void {
    this.effort = effort;
  }

  /**
   * Sync the model list and the effort options from a resolved llm config. Both callers (boot
   * catalog merge, hot reload) need the same projection, and `effortApplies` can only be derived
   * here from the backend, so a hand-written field list at each call site would drop it silently.
   */
  syncFromConfig(llm: LlmConfig): void {
    this.models = (llm.models ?? []).map((model) => ({
      id: model.id,
      label: model.label,
      group: model.group,
      supportedEffortLevels: model.supportedEffortLevels,
      supportsEffort: model.supportsEffort,
      effortApplies: effectiveEffort(llm, model.id).source !== "unsupported",
    }));
    this.effort = effortOptionsFor(llm);
  }

  hasModels(): boolean {
    return this.models.length > 0;
  }

  effortLevels(): EffortLevel[] {
    return this.effort.enabled ? this.effort.levels : [];
  }

  /** Effort levels for a specific model (falls back to global when the model has no override). */
  effortLevelsFor(modelId: string): EffortLevel[] {
    if (!this.effort.enabled) return [];
    const model = this.models.find((m) => m.id === modelId);
    if (model?.effortApplies === false) return [];
    if (model?.supportsEffort === false) return [];
    const levels = model?.supportedEffortLevels;
    return levels && levels.length > 0 ? levels : this.effort.levels;
  }

  /** Stable callback ref for a model id, safe to embed in a menu that may outlive the list order. */
  refForModel(modelId: string): string {
    return refFor(modelId);
  }

  /** Stable callback ref for a "/"-joined group path. */
  refForGroup(groupPath: string): string {
    return refFor(groupPath);
  }

  /**
   * Every distinct group node path (including intermediate prefixes) as "/"-joined strings,
   * in first-appearance order.
   */
  groupOrder(): string[] {
    const seen: string[] = [];
    for (const model of this.models) {
      const segments = splitGroup(model.group);
      for (let depth = 1; depth <= segments.length; depth++) {
        const path = segments.slice(0, depth).join("/");
        if (!seen.includes(path)) seen.push(path);
      }
    }
    return seen;
  }

  hasGroups(): boolean {
    return this.groupOrder().length > 0;
  }

  private childrenOf(pathSegments: string[]): { models: ModelOption[]; subgroups: string[] } {
    const prefix = pathSegments.join("/");
    const models: ModelOption[] = [];
    const subgroups: string[] = [];
    this.models.forEach((model) => {
      const segments = splitGroup(model.group);
      const modelPath = segments.join("/");
      if (modelPath === prefix) {
        models.push(model);
        return;
      }
      // Immediate subgroup one level below this node.
      if (segments.length > pathSegments.length && segments.slice(0, pathSegments.length).join("/") === prefix) {
        const childPath = segments.slice(0, pathSegments.length + 1).join("/");
        if (!subgroups.includes(childPath)) subgroups.push(childPath);
      }
    });
    return { models, subgroups };
  }

  private pathContainsModel(path: string, modelId: string): boolean {
    return this.models.some((m) => {
      if (m.id !== modelId) return false;
      const mp = splitGroup(m.group).join("/");
      return mp === path || mp.startsWith(`${path}/`);
    });
  }

  private nodeButtons(pathSegments: string[], currentModelId: string): ConfirmationButton[] {
    const { models, subgroups } = this.childrenOf(pathSegments);
    const buttons: ConfirmationButton[] = [];
    for (const model of models) {
      buttons.push({ label: mark(model.label, model.id === currentModelId), action: `mdl:${refFor(model.id)}` });
    }
    for (const childPath of subgroups) {
      const lastSegment = childPath.split("/").pop() ?? childPath;
      buttons.push({
        label: mark(`${lastSegment} >`, this.pathContainsModel(childPath, currentModelId)),
        action: `mdlg:${refFor(childPath)}`,
      });
    }
    return buttons;
  }

  /**
   * Root menu: ungrouped models + top-level group entries + an `Effort >` entry to adjust effort
   * without re-selecting a model. The active effort level is also shown on the header line;
   * selecting a model never forces the effort step. The entry is dropped when the current model
   * discards effort, where it would open a submenu that cannot change anything.
   */
  buildButtons(currentModelId: string): ConfirmationButton[] {
    const buttons = this.nodeButtons([], currentModelId);
    if (this.effortLevelsFor(currentModelId).length > 0) {
      buttons.push({ label: "Effort >", action: EFFORT_ACTION });
    }
    return buttons;
  }

  /** Header suffix showing the effective effort, omitted when the current model discards it. */
  effortHeaderSuffix(effort: EffectiveEffort): string {
    return effort.source === "unsupported" ? "" : ` — Effort: ${formatEffort(effort)}`;
  }

  /** Submenu at a group path: its models + subgroups + a back entry to its parent. */
  buildGroupButtons(groupPath: string, currentModelId: string): ConfirmationButton[] {
    if (!this.groupOrder().includes(groupPath)) return this.buildButtons(currentModelId);
    const segments = groupPath.split("/");
    const buttons = this.nodeButtons(segments, currentModelId);
    const parent = segments.slice(0, -1);
    const backAction = parent.length === 0 ? "mdlb" : `mdlg:${refFor(parent.join("/"))}`;
    buttons.push({ label: "< Back", action: backAction });
    return buttons;
  }

  /**
   * Effort submenu: one entry per level, then either a back entry (standalone /effort menu
   * or the Effort > entry from the root) or a "keep current" entry (chained right after a
   * model selection, where going back to the model menu would defeat the point of the chain).
   * When `currentModelId` is provided, only levels that model supports are shown.
   */
  buildEffortButtons(effort: EffectiveEffort, opts?: { chained?: boolean; currentModelId?: string }): ConfirmationButton[] {
    const levels = opts?.currentModelId ? this.effortLevelsFor(opts.currentModelId) : this.effort.levels;
    const buttons: ConfirmationButton[] = levels.map((level) => ({
      label: mark(level, level === effort.level),
      action: `eff:${level}`,
    }));
    if (opts?.chained) {
      buttons.push({ label: `Keep current: ${formatEffort(effort)}`, action: KEEP_EFFORT_ACTION });
    } else {
      buttons.push({ label: "< Back", action: "mdlb" });
    }
    return buttons;
  }

  groupLabel(groupPath: string): string | undefined {
    return this.groupOrder().includes(groupPath) ? groupPath.split("/").pop() : undefined;
  }

  /** Full callback intent (selection, navigation, or effort). */
  parseCallbackAction(data: string): PickerCallback | null {
    if (data === "mdlb") return { kind: "back" };
    if (data === EFFORT_ACTION) return { kind: "openEffort" };
    if (data === KEEP_EFFORT_ACTION) return { kind: "keepEffort" };

    const effort = /^eff:(.+)$/.exec(data);
    if (effort) {
      const level = effort[1] as EffortLevel;
      return this.effort.levels.includes(level) ? { kind: "setEffort", level } : null;
    }

    const group = /^mdlg:([0-9a-f]+)$/.exec(data);
    if (group) {
      const groupPath = buildRefMap(this.groupOrder()).get(group[1] ?? "");
      return groupPath ? { kind: "openGroup", groupPath } : { kind: "stale" };
    }

    // Only report staleness for data that is unmistakably ours, so callbacks owned by other
    // features still fall through untouched.
    if (/^mdl:[0-9a-f]+$/.test(data)) {
      const modelId = this.parseCallback(data);
      return modelId ? { kind: "select", modelId } : { kind: "stale" };
    }
    return null;
  }

  /**
   * Selection-only parse. An unknown ref means the model is gone from the list (a menu left open
   * across a discovery refresh), which resolves to null so the caller reports it instead of
   * picking whatever now sits at that position.
   */
  parseCallback(data: string): string | null {
    const match = /^mdl:([0-9a-f]+)$/.exec(data);
    if (!match) return null;
    return buildRefMap(this.models.map((m) => m.id)).get(match[1] ?? "") ?? null;
  }

  find(query: string): ModelOption | null {
    const normalizedQuery = normalize(query);
    if (!normalizedQuery) return null;

    const exact = this.models.find((model) =>
      [model.id, model.label, model.id.split("/").pop() ?? ""].some(
        (candidate) => normalize(candidate) === normalizedQuery,
      ),
    );
    if (exact) return exact;

    return (
      this.models.find((model) =>
        [model.id, model.label, model.id.split("/").pop() ?? ""].some((candidate) =>
          normalize(candidate).includes(normalizedQuery),
        ),
      ) ?? null
    );
  }

  labelFor(modelId: string): string {
    return this.models.find((model) => model.id === modelId)?.label ?? modelId;
  }
}

/**
 * Renders an effective effort as "<level> (<origin>)". The origin matters: "high because you set
 * it" and "high because the SDK falls back to it" answer the same question differently, and a
 * bare "default" answered neither.
 */
export function formatEffort(effort: EffectiveEffort): string {
  switch (effort.source) {
    case "session":
      return `${effort.level} (session)`;
    case "model":
      return `${effort.level} (model default)`;
    case "config":
      return `${effort.level} (config)`;
    case "sdk-default":
      return `${effort.level} (SDK default)`;
    case "provider-default":
      // Codex and opt-in OpenAI-compatible providers document no default, so naming one would
      // be an invention. The honest answer is that nothing is sent and the provider decides.
      return "provider default (nothing sent)";
    case "unsupported":
      return "not supported by this model";
  }
}

/** Parse a /effort argument into a valid level, or null. */
export function parseEffortArg(arg: string, levels: EffortLevel[]): EffortLevel | null {
  const normalized = arg.trim().toLowerCase();
  return levels.includes(normalized as EffortLevel) ? (normalized as EffortLevel) : null;
}
