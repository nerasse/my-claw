import type { Tool } from "../../tools/types.ts";
import type { SkillInfo } from "../../skills/types.ts";
import { loadAllPromptFiles, loadCorePrompt } from "./loader.ts";
import { getPlatformHint } from "./platform-hints.ts";
import { normalizeUntrusted } from "./normalize-untrusted.ts";
import type { PromptLayerName } from "../../agents/types.ts";

export interface PromptContext {
  platform: string;
  model: string;
  sessionId: string;
  tools: Tool[];
  skills: SkillInfo[];
  /** Secondary workspace of the run; prompt files missing there fall back to the default. */
  workspaceDir?: string;
  defaultWorkspaceDir?: string;
  // Skills the retrieval layer flagged as likely relevant to this message; rendered as a soft
  // reminder at the very end so it never mutates the cacheable prefix (see docs/skill-suggestions.md).
  suggestedSkills?: SkillInfo[];
  /** The running agent's own instructions, from its `agents/` file. See docs/file-agents.md. */
  agentPrompt?: string;
  /**
   * Which workspace prompt files this agent sits on. Absent means all of them, which is what every
   * agent got before agents could have a prompt of their own.
   */
  instructions?: readonly PromptLayerName[];
}

export async function buildSystemPrompt(ctx: PromptContext): Promise<string> {
  const layers: string[] = [];
  const wants = (layer: PromptLayerName): boolean => ctx.instructions === undefined || ctx.instructions.includes(layer);

  // Layer 0: Core directives. Owner-editable via workspace CORE.md, hardcoded fallback.
  if (wants("CORE")) {
    layers.push(await loadCorePrompt(ctx.workspaceDir, ctx.defaultWorkspaceDir));
  }

  // Layer 1-4: Workspace files (scanned for injection)
  const files = await loadAllPromptFiles(ctx.workspaceDir, ctx.defaultWorkspaceDir);
  const fileOrder: Array<[keyof typeof files, PromptLayerName]> = [
    ["SOUL.md", "SOUL"],
    ["AGENTS.md", "AGENTS"],
    ["USER.md", "USER"],
  ];
  for (const [name, layer] of fileOrder) {
    if (!wants(layer)) continue;
    const content = files[name];
    if (content) {
      layers.push(normalizeUntrusted(content, name));
    }
  }

  // Layer 4.5: the agent's own mandate. After the persona, which it specialises, and before the
  // catalogs, which stay adjacent to the runtime line at the end for prompt-cache stability.
  // Normalised like the workspace files: a workspace `agents/` file is no more trusted than
  // a workspace AGENTS.md.
  if (ctx.agentPrompt) {
    layers.push(normalizeUntrusted(ctx.agentPrompt, "agent"));
  }

  // Layer 5: Available skills
  if (ctx.skills.length > 0) {
    const skillList = ctx.skills
      .map((s) => `- ${s.name}: ${s.description}`)
      .join("\n");
    layers.push(
      `# Available skills\n\n${skillList}\n\n` +
        `Before replying, scan the skills above. If a skill matches your task, ` +
        `you MUST call read_skill(name) to load its full instructions. ` +
        `Only proceed without loading a skill if genuinely none are relevant.`,
    );
  }

  // Layer 6: Available tools
  if (ctx.tools.length > 0) {
    const toolList = ctx.tools
      .map((t) => `- ${t.name}: ${t.description}`)
      .join("\n");
    layers.push(`# Available tools\n\n${toolList}`);
  }

  // Layer 7: Platform hints
  const hint = getPlatformHint(ctx.platform);
  if (hint) {
    layers.push(hint);
  }

  // Layer 8: Runtime
  const now = new Date().toISOString();
  layers.push(
    `Runtime: date=${now} | model=${ctx.model} | channel=${ctx.platform} | session=${ctx.sessionId}`,
  );

  // Layer 9: Soft skill reminder. Placed last (after the already-dynamic runtime line) so it
  // never busts the cacheable prefix. Complements, not overrides, the "MUST read_skill" catalog.
  if (ctx.suggestedSkills && ctx.suggestedSkills.length > 0) {
    const hints = ctx.suggestedSkills
      .map((s) => `- ${s.name}: ${s.description}`)
      .join("\n");
    layers.push(
      `# Skills possibly relevant to this request\n\n${hints}\n\n` +
        `These look related to the current request. If one fits, call read_skill(name) to load ` +
        `its full instructions. Treat this as a hint, not an order.`,
    );
  }

  return layers.filter(Boolean).join("\n\n");
}
