import type { Tool } from "../../tools/types.ts";
import type { SkillInfo } from "../../skills/types.ts";
import { loadAllPromptFiles } from "./loader.ts";
import { getPlatformHint } from "./platform-hints.ts";
import { CORE_PROMPT } from "./core-prompts.ts";
import { scanForInjection } from "./anti-injection.ts";

export interface PromptContext {
  platform: string;
  model: string;
  channelId: string;
  sessionId: string;
  tools: Tool[];
  skills: SkillInfo[];
}

export async function buildSystemPrompt(ctx: PromptContext): Promise<string> {
  const layers: string[] = [];

  // Layer 0: Core directives (hardcoded, incassable)
  layers.push(CORE_PROMPT);

  // Layer 1-4: Workspace files (scanned for injection)
  const files = await loadAllPromptFiles();
  const fileOrder: Array<keyof typeof files> = ["SOUL.md", "AGENTS.md", "USER.md", "MEMORY.md"];
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

  return layers.filter(Boolean).join("\n\n");
}
