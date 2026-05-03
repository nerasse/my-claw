import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MY_CLAW_DIR } from "../config.ts";
import type { Tool, ToolResult } from "./types.ts";

const PROMPT_DIR = join(MY_CLAW_DIR, "prompt");

export const memoryTool: Tool = {
  name: "memory",
  description: "Read or append to MEMORY.md or USER.md",
  parameters: {
    type: "object",
    properties: {
      file: { type: "string", enum: ["MEMORY.md", "USER.md"], description: "Which file to operate on" },
      action: { type: "string", enum: ["read", "append"], description: "Read or append" },
      content: { type: "string", description: "Content to append (required for append)" },
    },
    required: ["file", "action"],
  },
  async execute(args): Promise<ToolResult> {
    const filePath = join(PROMPT_DIR, args["file"] as string);
    try {
      if (args["action"] === "read") {
        const content = await readFile(filePath, "utf-8");
        return { success: true, output: content };
      }
      const existing = await readFile(filePath, "utf-8").catch(() => "");
      const newContent = existing.trimEnd() + "\n" + (args["content"] as string) + "\n";
      await writeFile(filePath, newContent);
      return { success: true, output: `Appended to ${args["file"]}` };
    } catch (e) {
      return { success: false, output: "", error: String(e) };
    }
  },
};
