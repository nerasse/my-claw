import { createHash } from "node:crypto";
import type { ConfirmationButton } from "./types.ts";
import type { AgentConfigKey, EffortLevel, LlmConfig, TagConfig } from "../core/config.ts";
import { tagNameOf } from "../core/config.ts";
import { effectiveEffort, effortOptionsFor, type EffectiveEffort } from "../llm/resolver.ts";
import type { ContextOverride } from "../llm/context-window.ts";

export interface ModelOption {
  id: string;
  label: string;
  /**
   * Provider key this model belongs to. Needed when pinning a model into config.json: most models
   * come from provider discovery and are absent from the file, so recording only the id would let
   * a later offline start resolve it against the wrong endpoint.
   */
  provider?: string;
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

/**
 * Which model a menu is about to change. Absent means the session's own model, the original and
 * still the default behaviour of `/model`. A value means an agent's persisted default in config.
 *
 * Encoded as a single letter inside callback_data: Telegram caps it at 64 bytes and the model ref
 * already spends 12 of them, so the target must not cost a word.
 */
export type PickerTarget = string;

/**
 * The code an agent rides under inside callback_data.
 *
 * The two reserved roles keep their historic letter. Everything else is a hash of the name rather
 * than an index into the listing: an index would silently retarget when an agent file appears or
 * disappears under a menu left open, and writing config for the wrong agent is the one outcome
 * this encoding must make impossible. Four base36 characters keep the suffix inside Telegram's
 * 64-byte cap, which the model ref already spends 12 of.
 */
function targetCode(target: PickerTarget): string {
  if (target === "orchestrator") return "o";
  if (target === "cron") return "c";
  let hash = 0;
  for (let i = 0; i < target.length; i++) hash = (Math.imul(hash, 31) + target.charCodeAt(i)) >>> 0;
  return hash.toString(36).padStart(4, "0").slice(-4);
}

/** Suffix appended to every action of an agent-targeted menu, so navigation keeps its target. */
function targetSuffix(target?: PickerTarget): string {
  return target ? `@${targetCode(target)}` : "";
}

// A picker callback is a model selection, a submenu navigation step, or an effort change.
// keepEffort finalizes the chained model->effort flow without touching the session's effort.
// `target` rides along on selection and navigation so a submenu does not lose which agent it edits.
export type PickerCallback =
  | { kind: "select"; modelId: string; target?: PickerTarget }
  | { kind: "openGroup"; groupPath: string; target?: PickerTarget }
  | { kind: "back"; target?: PickerTarget }
  | { kind: "openEffort"; target?: PickerTarget }
  | { kind: "setEffort"; level: EffortLevel; target?: PickerTarget }
  | { kind: "keepEffort"; target?: PickerTarget }
  | { kind: "openContext"; target?: PickerTarget }
  | { kind: "setContext"; choice: ContextOverride; target?: PickerTarget }
  | { kind: "keepContext" }
  // A picker button whose target no longer exists (menu left open across a discovery refresh).
  | { kind: "stale" };

const EFFORT_ACTION = "effm";
const KEEP_EFFORT_ACTION = "effk";
const CONTEXT_ACTION = "ctxm";
const KEEP_CONTEXT_ACTION = "ctxk";

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
    /** Spawnable agent names, read live so a menu built after a `agents/` drop-in can target it. */
    private listAgentTargets: () => string[] = () => [],
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
   *
   * User tags ride on the llm view as synthetic entries: the virtual `tag:Default` first, then
   * one entry per tag, all under a single "Tags" group so the picker reads as one submenu and
   * the provider list gets its top row for free (docs/tags.md).
   */
  syncFromConfig(llm: LlmConfig, tags?: Record<string, TagConfig>): void {
    const tagEntries: ModelOption[] = [
      {
        id: "tag:Default",
        label: "Default",
        group: "Tags",
        provider: "tags",
        effortApplies: effectiveEffort(llm, "tag:Default").source !== "unsupported",
      },
      ...Object.entries(tags ?? {}).map(([name, tag]) => ({
        id: `tag:${name}`,
        label: name,
        group: "Tags",
        provider: "tags",
        effortApplies: effectiveEffort(llm, `tag:${name}`).source !== "unsupported",
      })),
    ];
    this.models = [
      ...tagEntries,
      ...(llm.models ?? []).map((model) => ({
        id: model.id,
        label: model.label,
        provider: model.provider,
        group: model.group,
        supportedEffortLevels: model.supportedEffortLevels,
        supportsEffort: model.supportsEffort,
        effortApplies: effectiveEffort(llm, model.id).source !== "unsupported",
      })),
    ];
    this.effort = effortOptionsFor(llm);
  }

  hasModels(): boolean {
    return this.models.length > 0;
  }

  /** The whole list, for channels that render the menu elsewhere (my-claw-app frames). */
  options(): readonly ModelOption[] {
    return this.models;
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

  private nodeButtons(pathSegments: string[], currentModelId: string, target?: PickerTarget): ConfirmationButton[] {
    const { models, subgroups } = this.childrenOf(pathSegments);
    const suffix = targetSuffix(target);
    const buttons: ConfirmationButton[] = [];
    for (const model of models) {
      buttons.push({ label: mark(model.label, model.id === currentModelId), action: `mdl:${refFor(model.id)}${suffix}` });
    }
    for (const childPath of subgroups) {
      const lastSegment = childPath.split("/").pop() ?? childPath;
      buttons.push({
        label: mark(`${lastSegment} >`, this.pathContainsModel(childPath, currentModelId)),
        action: `mdlg:${refFor(childPath)}${suffix}`,
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
  buildButtons(currentModelId: string, target?: PickerTarget, opts?: { contextChoice?: boolean }): ConfirmationButton[] {
    const buttons = this.nodeButtons([], currentModelId, target);
    // Effort rides on agent menus too since the config edit pins it now. The entry stays off
    // when the model discards effort, and off an agent whose model is a tag: the tag's own pin
    // would always win, so writing one here would be dead config.
    if (this.effortLevelsFor(currentModelId).length > 0 && (!target || tagNameOf(currentModelId) === undefined)) {
      buttons.push({ label: "Effort >", action: `${EFFORT_ACTION}${targetSuffix(target)}` });
    }
    // Only when there is more than one ceiling worth offering: otherwise the submenu would show a
    // single option, which is not a choice. Unlike effort, this is offered on an agent menu too --
    // a research sub-agent and a cron job do not want the same window.
    if (opts?.contextChoice) {
      buttons.push({ label: "Context >", action: CONTEXT_ACTION });
    }
    return buttons;
  }

  /**
   * Context submenu: the full window against the capped one, with the active choice marked.
   * A root-level entry rather than a step chained after picking a model -- the cap is a standing
   * policy that rarely changes, and a third screen on every model switch would cost more than it
   * saves. See docs/context-window.md.
   */
  buildContextButtons(
    tiers: readonly { ceiling?: number; label: string; selected: boolean }[],
    opts?: { chained?: boolean; target?: PickerTarget },
  ): ConfirmationButton[] {
    const suffix = targetSuffix(opts?.target);
    const buttons: ConfirmationButton[] = tiers.map((tier) => ({
      label: mark(tier.label, tier.selected),
      action: `ctx:${tier.ceiling ?? "full"}${suffix}`,
    }));
    // Chained right after the effort step, going back to the model menu would defeat the flow, so
    // the escape is "leave it as it is" instead. Mirrors the effort submenu.
    buttons.push(
      opts?.chained
        ? { label: `Keep current: ${tiers.find((t) => t.selected)?.label ?? "unchanged"}`, action: `${KEEP_CONTEXT_ACTION}${suffix}` }
        : { label: "< Back", action: `mdlb${suffix}` },
    );
    return buttons;
  }

  /** Header suffix showing the effective effort, omitted when the current model discards it. */
  effortHeaderSuffix(effort: EffectiveEffort): string {
    return effort.source === "unsupported" ? "" : ` — Effort: ${formatEffort(effort)}`;
  }

  /** Submenu at a group path: its models + subgroups + a back entry to its parent. */
  buildGroupButtons(groupPath: string, currentModelId: string, target?: PickerTarget): ConfirmationButton[] {
    if (!this.groupOrder().includes(groupPath)) return this.buildButtons(currentModelId, target);
    const segments = groupPath.split("/");
    const buttons = this.nodeButtons(segments, currentModelId, target);
    const parent = segments.slice(0, -1);
    const suffix = targetSuffix(target);
    const backAction = parent.length === 0 ? `mdlb${suffix}` : `mdlg:${refFor(parent.join("/"))}${suffix}`;
    buttons.push({ label: "< Back", action: backAction });
    return buttons;
  }

  /**
   * Effort submenu: one entry per level, then either a back entry (standalone /effort menu
   * or the Effort > entry from the root) or a "keep current" entry (chained right after a
   * model selection, where going back to the model menu would defeat the point of the chain).
   * When `currentModelId` is provided, only levels that model supports are shown.
   */
  buildEffortButtons(effort: EffectiveEffort, opts?: { chained?: boolean; currentModelId?: string; target?: PickerTarget }): ConfirmationButton[] {
    const suffix = targetSuffix(opts?.target);
    const levels = opts?.currentModelId ? this.effortLevelsFor(opts.currentModelId) : this.effort.levels;
    const buttons: ConfirmationButton[] = levels.map((level) => ({
      label: mark(level, level === effort.level),
      action: `eff:${level}${suffix}`,
    }));
    if (opts?.chained) {
      buttons.push({ label: `Keep current: ${formatEffort(effort)}`, action: `${KEEP_EFFORT_ACTION}${suffix}` });
    } else {
      buttons.push({ label: "< Back", action: `mdlb${suffix}` });
    }
    return buttons;
  }

  groupLabel(groupPath: string): string | undefined {
    return this.groupOrder().includes(groupPath) ? groupPath.split("/").pop() : undefined;
  }

  /**
   * The agent a code refers to, or undefined when nothing (or more than one thing) matches.
   *
   * Two agents hashing to the same code is refused rather than resolved to the first: a menu that
   * does nothing is recoverable, one that writes the wrong agent's config is not.
   */
  private targetByCode(code: string): PickerTarget | undefined {
    const candidates = ["orchestrator", "cron", ...this.listAgentTargets()]
      .filter((target) => targetCode(target) === code);
    return candidates.length === 1 ? candidates[0] : undefined;
  }

  /** Full callback intent (selection, navigation, or effort). */
  parseCallbackAction(data: string): PickerCallback | null {
    // The target is stripped first so every branch below parses the same shapes it always did.
    // An unknown letter is treated as no target rather than as a target: falling back to the
    // session is recoverable, writing config for the wrong agent is not.
    const targeted = /^(.*)@([a-z0-9]{1,4})$/.exec(data);
    const target = targeted ? this.targetByCode(targeted[2] ?? "") : undefined;
    if (targeted && !target) return null;
    const bare = target ? targeted?.[1] ?? data : data;

    if (bare === "mdlb") return { kind: "back", ...(target ? { target } : {}) };
    if (bare === EFFORT_ACTION) return { kind: "openEffort", ...(target ? { target } : {}) };
    if (bare === CONTEXT_ACTION) return { kind: "openContext", ...(target ? { target } : {}) };
    if (bare === KEEP_CONTEXT_ACTION) return { kind: "keepContext" };

    const ctx = /^ctx:(full|[0-9]+)$/.exec(bare);
    if (ctx) {
      const raw = ctx[1] ?? "";
      const choice: ContextOverride = raw === "full" ? "full" : Number(raw);
      // A zero or unparsable ceiling would silently mean "no window at all".
      if (choice !== "full" && !(choice > 0)) return null;
      return { kind: "setContext", choice, ...(target ? { target } : {}) };
    }
    if (bare === KEEP_EFFORT_ACTION) return { kind: "keepEffort", ...(target ? { target } : {}) };

    const effort = /^eff:(.+)$/.exec(bare);
    if (effort) {
      const level = effort[1] as EffortLevel;
      return this.effort.levels.includes(level) ? { kind: "setEffort", level, ...(target ? { target } : {}) } : null;
    }

    const group = /^mdlg:([0-9a-f]+)$/.exec(bare);
    if (group) {
      const groupPath = buildRefMap(this.groupOrder()).get(group[1] ?? "");
      return groupPath ? { kind: "openGroup", groupPath, ...(target ? { target } : {}) } : { kind: "stale" };
    }

    // Only report staleness for data that is unmistakably ours, so callbacks owned by other
    // features still fall through untouched.
    if (/^mdl:[0-9a-f]+$/.test(bare)) {
      const modelId = this.parseCallback(bare);
      return modelId ? { kind: "select", modelId, ...(target ? { target } : {}) } : { kind: "stale" };
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

  /** The provider a model belongs to, or undefined when it follows the global default. */
  providerFor(modelId: string): string | undefined {
    return this.models.find((model) => model.id === modelId)?.provider;
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
    case "tag":
      return `${effort.level} (tag pin)`;
    case "scope":
      return `${effort.level} (job or agent pin)`;
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
