import type { Tool } from "../../tools/types.ts";
import type { SkillInfo } from "../../skills/types.ts";
import { loadAllPromptFiles, loadCorePrompt } from "./loader.ts";
import { getPlatformHint } from "./platform-hints.ts";
import { scanForInjection } from "./anti-injection.ts";

export interface PromptContext {
  platform: string;
  model: string;
  channelId: string;
  sessionId: string;
  tools: Tool[];
  skills: SkillInfo[];
  // Skills the retrieval layer flagged as likely relevant to this message; rendered as a soft
  // reminder at the very end so it never mutates the cacheable prefix (see docs/skill-suggestions.md).
  suggestedSkills?: SkillInfo[];
}

export async function buildSystemPrompt(ctx: PromptContext): Promise<string> {
  const layers: string[] = [];

  // Layer 0: Core directives. Owner-editable via workspace CORE.md, hardcoded fallback.
  layers.push(await loadCorePrompt());

  // Layer 1-4: Workspace files (scanned for injection)
  const files = await loadAllPromptFiles();
  const fileOrder: Array<keyof typeof files> = ["SOUL.md", "AGENTS.md", "USER.md"];
  for (const name of fileOrder) {
    const content = files[name];
    if (content) {
      layers.push(scanForInjection(content, name));
    }
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
