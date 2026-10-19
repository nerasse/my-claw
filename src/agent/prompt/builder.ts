import type { SkillInfo } from "../../skills/types.ts";
import { resolveCorePrompt, resolvePromptFile, type PromptFileResolution, type PromptResolveOptions } from "./loader.ts";
import { PROMPT_LAYER_OF_FILE, WORKSPACE_PROMPT_FILES, type PromptFile, type PromptLayerName } from "./files.ts";
import type { WorkspacePromptPolicy } from "../../core/config.ts";
import { getPlatformHint } from "./platform-hints.ts";
import { normalizeUntrusted } from "./normalize-untrusted.ts";

export interface PromptContext {
  platform: string;
  model: string;
  sessionId: string;
  skills: SkillInfo[];
  /** Secondary workspace of the run; prompt files missing there fall back per the policy below. */
  workspaceDir?: string;
  defaultWorkspaceDir?: string;
  /** The run's workspace key (config.workspaces), the key the prompt policy is indexed by. */
  workspaceKey?: string;
  /** config.workspaces: resolves an inherited source key to its directory. */
  workspaces?: Record<string, string>;
  /** config.workspacePrompts: per-workspace per-file prompt policies. */
  workspacePrompts?: Record<string, WorkspacePromptPolicy>;
  /** The running agent's own instructions, from its `agents/` file. See docs/file-agents.md. */
  agentPrompt?: string;
  /**
   * Which workspace prompt files this agent sits on. Absent means all of them, which is what every
   * agent got before agents could have a prompt of their own.
   */
  instructions?: readonly PromptLayerName[];
  /**
   * Derived layers this session turned off ("agent", "skills", "platform", "runtime",
   * "suggested"). The four workspace files are gated by `instructions`/`wants` instead. An off
   * layer is simply skipped during composition, so the run and the instructions page can never
   * drift: both go through this one function.
   */
  layersOff?: readonly string[];
}

/** A layer of the composed prompt, kept apart so a reader can be shown what each one contributed. */
export interface PromptPart {
  /** Stable across builds: the four files use their layer name, the derived ones their own. */
  id: PromptLayerName | "agent" | "skills" | "platform" | "runtime";
  label: string;
  text: string;
  /** The prompt file this layer was read from, absent for a derived layer. */
  file?: PromptFile;
  /** Which step of the resolution ladder produced the text. Only for the file layers. */
  origin?: PromptFileResolution["origin"];
  /** Directory the content came from, "" for a shipped template. Only for the file layers. */
  from?: string;
}

/**
 * The prompt as the list of layers it is made of, in build order. `buildSystemPrompt` is the join
 * of this, so the instructions page and the run cannot drift: the page shows what the run sends,
 * layer by layer, rather than a second composition written to look like the first.
 */
export async function composeSystemPrompt(ctx: PromptContext): Promise<PromptPart[]> {
  const parts: PromptPart[] = [];
  const wants = (layer: PromptLayerName): boolean => ctx.instructions === undefined || ctx.instructions.includes(layer);
  const layerOff = (id: string): boolean => ctx.layersOff !== undefined && ctx.layersOff.includes(id);

  const promptOpts: PromptResolveOptions = {
    workspaceDir: ctx.workspaceDir,
    defaultWorkspaceDir: ctx.defaultWorkspaceDir,
    workspaceKey: ctx.workspaceKey,
    workspaces: ctx.workspaces,
    workspacePrompts: ctx.workspacePrompts,
  };

  // Layer 0: Core directives. Owner-editable via workspace CORE.md, hardcoded fallback.
  if (wants("CORE")) {
    const core = await resolveCorePrompt(promptOpts);
    parts.push({ id: "CORE", label: "Core directives", text: core.content, file: "CORE.md", origin: core.origin, from: core.from });
  }

  // Layer 1-4: Workspace files (scanned for injection)
  for (const file of WORKSPACE_PROMPT_FILES) {
    const layer = PROMPT_LAYER_OF_FILE[file];
    if (!wants(layer)) continue;
    const res = await resolvePromptFile(file, promptOpts);
    parts.push({
      id: layer,
      label: file,
      text: res.content ? normalizeUntrusted(res.content, file) : "",
      file,
      origin: res.origin,
      from: res.from,
    });
  }

  // Layer 4.5: the agent's own mandate. After the persona, which it specialises, and before the
  // catalogs, which stay adjacent to the runtime line at the end for prompt-cache stability.
  // Normalised like the workspace files: a workspace `agents/` file is no more trusted than
  // a workspace AGENTS.md.
  if (ctx.agentPrompt && !layerOff("agent")) {
    parts.push({ id: "agent", label: "Agent mandate", text: normalizeUntrusted(ctx.agentPrompt, "agent") });
  }

  // Layer 5: Available skills
  if (ctx.skills.length > 0 && !layerOff("skills")) {
    const skillList = ctx.skills
      .map((s) => `- ${s.name}: ${s.description}`)
      .join("\n");
    parts.push({
      id: "skills",
      label: "Available skills",
      text:
        `# Available skills\n\n${skillList}\n\n` +
        `Before replying, scan the skills above. If a skill matches your task, ` +
        `you MUST call skills(name) to load its full instructions. ` +
        `Only proceed without loading a skill if genuinely none are relevant.`,
    });
  }

  // No tool layer: every tool's name and description already go out with the request, in the
  // tool definitions every engine sends. Listing them here as well sent each description twice,
  // on every request (removed 2026-10-04, docs/tools.md).

  // Layer 7: Platform hints
  const hint = getPlatformHint(ctx.platform);
  if (hint && !layerOff("platform")) {
    parts.push({ id: "platform", label: "Platform hints", text: hint });
  }

  // Layer 8: Runtime. No timestamp here: this is the cached prefix, and a clock in it invalidates
  // the whole conversation on every turn. The current time travels in the inbound turn instead
  // (`turn-context.ts`). Model, channel and session are stable for a session; a model switch is a
  // full reset on its own.
  if (!layerOff("runtime")) {
    parts.push({
      id: "runtime",
      label: "Runtime",
      text: `Runtime: model=${ctx.model} | channel=${ctx.platform} | session=${ctx.sessionId}`,
    });
  }

  return parts;
}

export async function buildSystemPrompt(ctx: PromptContext): Promise<string> {
  return (await composeSystemPrompt(ctx))
    .map((part) => part.text)
    .filter(Boolean)
    .join("\n\n");
}
