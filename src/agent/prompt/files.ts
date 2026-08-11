/**
 * The prompt files buildSystemPrompt reads, and the layer each feeds. One canonical list: the
 * loader, the template seeding and the instructions page each carried their own copy of it and
 * drifted (the loader skipped CORE.md, the seeding added SYSTEM.md no line of src/ reads).
 * Anything that names a prompt file imports from here.
 */
export type PromptLayerName = "CORE" | "SOUL" | "AGENTS" | "USER";

/** The four editable prompt files, in build order. */
export const PROMPT_FILES = ["CORE.md", "SOUL.md", "AGENTS.md", "USER.md"] as const;

export type PromptFile = (typeof PROMPT_FILES)[number];

/** File to layer. The one place the two namespaces meet. */
export const PROMPT_LAYER_OF_FILE: Record<PromptFile, PromptLayerName> = {
  "CORE.md": "CORE",
  "SOUL.md": "SOUL",
  "AGENTS.md": "AGENTS",
  "USER.md": "USER",
};

/** The prompt layer names, in build order. */
export const PROMPT_LAYERS: readonly PromptLayerName[] = PROMPT_FILES.map((file) => PROMPT_LAYER_OF_FILE[file]);

/**
 * The files `loadAllPromptFiles` reads. CORE.md is handled separately: only it has a hardcoded
 * fallback (`CORE_PROMPT`), so it needs `loadCorePrompt`, not the plain list.
 */
export const WORKSPACE_PROMPT_FILES = ["SOUL.md", "AGENTS.md", "USER.md"] as const satisfies readonly PromptFile[];

export type WorkspacePromptFile = (typeof WORKSPACE_PROMPT_FILES)[number];
