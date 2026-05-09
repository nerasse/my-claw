import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MY_CLAW_DIR } from "../core/config.ts";
import type { Tool, ToolResult } from "./types.ts";
import { formatError } from "../utils/errors.ts";

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
    const file = args["file"] as string;
    const action = args["action"] as string;
    if (!file) {
      return { success: false, output: "file is required. Must be 'MEMORY.md' or 'USER.md'." };
    }
    if (!action) {
      return { success: false, output: "action is required. Must be 'read' or 'append'." };
    }
    const filePath = join(PROMPT_DIR, file);
    try {
      if (action === "read") {
        const content = await readFile(filePath, "utf-8");
        return { success: true, output: content };
      }
      if (action === "append") {
        const contentToAppend = args["content"] as string;
        if (!contentToAppend || !contentToAppend.trim()) {
          return { success: false, output: "content is required for append action and cannot be empty." };
        }
        const existing = await readFile(filePath, "utf-8").catch(() => "");
        const newContent = existing.trimEnd() + "\n" + contentToAppend + "\n";
        await writeFile(filePath, newContent);
        return { success: true, output: `Appended to ${file}` };
      }
      return { success: false, output: `Invalid action: "${action}". Must be 'read' or 'append'.` };
    } catch (e) {
      return { success: false, output: "", error: formatError(`Failed to ${action} "${file}"`, e) };
    }
  },
};
