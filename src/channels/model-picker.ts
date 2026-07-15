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
export type PickerCallback =
  | { kind: "select"; modelId: string }
  | { kind: "openGroup"; groupIndex: number }
  | { kind: "back" }
  | { kind: "openEffort" }
  | { kind: "setEffort"; level: EffortLevel };

const EFFORT_ACTION = "effm";

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
 * Text listing (for /models) with grouped models under headings. Numbers stay the global
 * 1-based position in the config array so they line up with the interactive picker; nested
 * groups render their full "A / B" path as the heading.
 */
export function formatGroupedModelList(
  models: readonly ModelOption[],
  currentModelId: string,
): string[] {
  const line = (m: ModelOption, index: number, indent: boolean) =>
    `${indent ? "  " : ""}${index + 1}. ${m.label} (${m.id})${m.id === currentModelId ? " [selected]" : ""}`;

  const lines: string[] = [];
  models.forEach((m, index) => {
    if (!m.group) lines.push(line(m, index, false));
  });

  const groups: string[] = [];
  for (const m of models) {
    if (m.group && !groups.includes(m.group)) groups.push(m.group);
  }
  for (const group of groups) {
    lines.push(`${splitGroup(group).join(" / ")}:`);
    models.forEach((m, index) => {
      if (m.group === group) lines.push(line(m, index, true));
    });
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

  /** Effort submenu: one entry per level + back to root. */
  buildEffortButtons(currentEffort?: EffortLevel): ConfirmationButton[] {
    const buttons: ConfirmationButton[] = this.effort.levels.map((level) => ({
      label: mark(level, level === currentEffort),
      action: `eff:${level}`,
    }));
    buttons.push({ label: "< Back", action: "mdlb" });
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
