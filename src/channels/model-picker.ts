import type { ConfirmationButton } from "./types.ts";

export interface ModelOption {
  id: string;
  label: string;
  group?: string;
}

// A picker callback is either a direct model selection or a submenu navigation step. Kept as a
// discriminated union so the channel handlers branch on intent instead of re-parsing strings.
export type PickerCallback =
  | { kind: "select"; modelId: string }
  | { kind: "openGroup"; groupIndex: number }
  | { kind: "back" };

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * Text listing (for /models) with grouped models under headings. Numbers stay the global
 * 1-based position in the config array so they line up with the interactive picker.
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
    lines.push(`${group}:`);
    models.forEach((m, index) => {
      if (m.group === group) lines.push(line(m, index, true));
    });
  }
  return lines;
}

function mark(label: string, selected: boolean): string {
  return selected ? `${label} [selected]` : label;
}

export class ModelPicker {
  constructor(private models: ModelOption[]) {}

  /** Replace the model list at runtime (used by the config hot-reload watcher). */
  setModels(models: ModelOption[]): void {
    this.models = models;
  }

  hasModels(): boolean {
    return this.models.length > 0;
  }

  /** Distinct group labels in first-appearance order; groupIndex indexes into this. */
  groupOrder(): string[] {
    const seen: string[] = [];
    for (const model of this.models) {
      if (model.group && !seen.includes(model.group)) seen.push(model.group);
    }
    return seen;
  }

  hasGroups(): boolean {
    return this.groupOrder().length > 0;
  }

  /** Root menu: ungrouped models as direct picks + one submenu entry per group. */
  buildButtons(currentModelId: string): ConfirmationButton[] {
    const buttons: ConfirmationButton[] = [];
    this.models.forEach((model, index) => {
      if (model.group) return; // grouped models live behind their submenu entry
      buttons.push({ label: mark(model.label, model.id === currentModelId), action: `mdl:${index}` });
    });
    this.groupOrder().forEach((group, groupIndex) => {
      const containsCurrent = this.models.some((m) => m.group === group && m.id === currentModelId);
      buttons.push({ label: mark(`${group} >`, containsCurrent), action: `mdlg:${groupIndex}` });
    });
    return buttons;
  }

  /** Submenu: the models of one group + a back entry to the root menu. */
  buildGroupButtons(groupIndex: number, currentModelId: string): ConfirmationButton[] {
    const group = this.groupOrder()[groupIndex];
    if (group === undefined) return this.buildButtons(currentModelId);
    const buttons: ConfirmationButton[] = [];
    this.models.forEach((model, index) => {
      if (model.group !== group) return;
      buttons.push({ label: mark(model.label, model.id === currentModelId), action: `mdl:${index}` });
    });
    buttons.push({ label: "< Back", action: "mdlb" });
    return buttons;
  }

  groupLabel(groupIndex: number): string | undefined {
    return this.groupOrder()[groupIndex];
  }

  /** Full callback intent (selection or navigation). */
  parseCallbackAction(data: string): PickerCallback | null {
    if (data === "mdlb") return { kind: "back" };
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
