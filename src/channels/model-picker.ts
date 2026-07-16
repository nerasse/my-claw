import type { ConfirmationButton } from "./types.ts";
import type { EffortLevel } from "../core/config.ts";

export interface ModelOption {
  id: string;
  label: string;
  // "/"-separated path; each segment is one submenu level (e.g. "Claude/Opus").
  group?: string;
}

export interface EffortOptions {
  enabled: boolean;
  levels: EffortLevel[];
}

// A picker callback is a model selection, a submenu navigation step, or an effort change.
// keepEffort finalizes the chained model->effort flow without touching the session's effort.
export type PickerCallback =
  | { kind: "select"; modelId: string }
  | { kind: "openGroup"; groupIndex: number }
  | { kind: "back" }
  | { kind: "openEffort" }
  | { kind: "setEffort"; level: EffortLevel }
  | { kind: "keepEffort" };

const EFFORT_ACTION = "effm";
const KEEP_EFFORT_ACTION = "effk";

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

  hasModels(): boolean {
    return this.models.length > 0;
  }

  effortLevels(): EffortLevel[] {
    return this.effort.enabled ? this.effort.levels : [];
  }

  /**
   * Every distinct group node path (including intermediate prefixes) as "/"-joined strings,
   * in first-appearance order. groupIndex in callbacks indexes into this list.
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

  private childrenOf(pathSegments: string[]): {
    models: Array<{ model: ModelOption; index: number }>;
    subgroups: string[];
  } {
    const prefix = pathSegments.join("/");
    const models: Array<{ model: ModelOption; index: number }> = [];
    const subgroups: string[] = [];
    this.models.forEach((model, index) => {
      const segments = splitGroup(model.group);
      const modelPath = segments.join("/");
      if (modelPath === prefix) {
        models.push({ model, index });
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
    for (const { model, index } of models) {
      buttons.push({ label: mark(model.label, model.id === currentModelId), action: `mdl:${index}` });
    }
    const paths = this.groupOrder();
    for (const childPath of subgroups) {
      const groupIndex = paths.indexOf(childPath);
      const lastSegment = childPath.split("/").pop() ?? childPath;
      buttons.push({
        label: mark(`${lastSegment} >`, this.pathContainsModel(childPath, currentModelId)),
        action: `mdlg:${groupIndex}`,
      });
    }
    return buttons;
  }

  /** Root menu: ungrouped models + top-level group entries + (optional) effort entry. */
  buildButtons(currentModelId: string, currentEffort?: EffortLevel): ConfirmationButton[] {
    const buttons = this.nodeButtons([], currentModelId);
    if (this.effort.enabled && this.effort.levels.length > 0) {
      buttons.push({ label: `Effort: ${currentEffort ?? "default"} >`, action: EFFORT_ACTION });
    }
    return buttons;
  }

  /** Submenu at a group path: its models + subgroups + a back entry to its parent. */
  buildGroupButtons(groupIndex: number, currentModelId: string): ConfirmationButton[] {
    const path = this.groupOrder()[groupIndex];
    if (path === undefined) return this.buildButtons(currentModelId);
    const segments = path.split("/");
    const buttons = this.nodeButtons(segments, currentModelId);
    const parent = segments.slice(0, -1);
    const backAction = parent.length === 0 ? "mdlb" : `mdlg:${this.groupOrder().indexOf(parent.join("/"))}`;
    buttons.push({ label: "< Back", action: backAction });
    return buttons;
  }

  /**
   * Effort submenu: one entry per level, then either a back entry (standalone /effort menu)
   * or a "keep current" entry (chained right after a model selection, where going back to the
   * model menu would defeat the point of the chain).
   */
  buildEffortButtons(currentEffort?: EffortLevel, opts?: { chained?: boolean }): ConfirmationButton[] {
    const buttons: ConfirmationButton[] = this.effort.levels.map((level) => ({
      label: mark(level, level === currentEffort),
      action: `eff:${level}`,
    }));
    if (opts?.chained) {
      buttons.push({ label: `Keep current (${currentEffort ?? "default"})`, action: KEEP_EFFORT_ACTION });
    } else {
      buttons.push({ label: "< Back", action: "mdlb" });
    }
    return buttons;
  }

  groupLabel(groupIndex: number): string | undefined {
    const path = this.groupOrder()[groupIndex];
    return path?.split("/").pop();
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

    const group = /^mdlg:(\d+)$/.exec(data);
    if (group) {
      const groupIndex = Number(group[1]);
      if (Number.isInteger(groupIndex) && groupIndex >= 0 && groupIndex < this.groupOrder().length) {
        return { kind: "openGroup", groupIndex };
      }
      return null;
    }

    const modelId = this.parseCallback(data);
    return modelId ? { kind: "select", modelId } : null;
  }

  /** Selection-only parse (kept for callers that just need the resolved model id). */
  parseCallback(data: string): string | null {
    const match = /^mdl:(\d+)$/.exec(data);
    if (!match) return null;

    const index = Number(match[1]);
    if (!Number.isInteger(index) || index < 0 || index >= this.models.length) {
      return null;
    }

    return this.models[index]?.id ?? null;
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

/** Parse a /effort argument into a valid level, or null. */
export function parseEffortArg(arg: string, levels: EffortLevel[]): EffortLevel | null {
  const normalized = arg.trim().toLowerCase();
  return levels.includes(normalized as EffortLevel) ? (normalized as EffortLevel) : null;
}
