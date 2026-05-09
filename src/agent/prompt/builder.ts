import type { Tool } from "../../tools/types.ts";
import type { SkillInfo } from "../../skills/types.ts";
import { loadAllPromptFiles } from "./loader.ts";
import { getPlatformHint } from "./platform-hints.ts";

export interface PromptContext {
  platform: string;
  model: string;
  channelId: string;
  sessionId: string;
  tools: Tool[];
  skills: SkillInfo[];
}

export async function buildSystemPrompt(ctx: PromptContext): Promise<string> {
  const files = await loadAllPromptFiles();

  const layers: string[] = [];

  // Layer 1: Identity
  if (files["SOUL.md"]) {
    layers.push(files["SOUL.md"]);
  }

  // Layer 2: Directives
  if (files["AGENTS.md"]) {
    layers.push(files["AGENTS.md"]);
  }

  // Layer 3: User context
  if (files["USER.md"]) {
    layers.push(files["USER.md"]);
  }

  // Layer 4: Memory (frozen snapshot)
  if (files["MEMORY.md"]) {
    layers.push(files["MEMORY.md"]);
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

  return layers.filter(Boolean).join("\n\n");
}
