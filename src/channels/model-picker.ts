import type { ConfirmationButton } from "./types.ts";

export interface ModelOption {
  id: string;
  label: string;
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
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

  buildButtons(currentModelId: string): ConfirmationButton[] {
    return this.models.map((model, index) => ({
      label: model.id === currentModelId ? `${model.label} [selected]` : model.label,
      action: `mdl:${index}`,
    }));
  }

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
