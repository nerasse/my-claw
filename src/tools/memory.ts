import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MY_CLAW_DIR } from "../core/config.ts";
import { type Tool, type ToolResult, str } from "./types.ts";
import { formatError } from "../utils/errors.ts";
import { hooks } from "../hooks/index.ts";

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
    const file = str(args, "file");
    const action = str(args, "action");
    if (!file || (file !== "MEMORY.md" && file !== "USER.md")) {
      return { success: false, output: "file is required. Must be 'MEMORY.md' or 'USER.md'." };
    }
    if (!action) {
      return { success: false, output: "action is required. Must be 'read' or 'append'." };
    }
    const filePath = join(PROMPT_DIR, file);
    try {
      if (action === "read") {
        const content = await readFile(filePath, "utf-8");
        hooks.emit("memory:read", { file, contentLength: content.length });
        return { success: true, output: content };
      }
      if (action === "append") {
        const contentToAppend = str(args, "content");
        if (!contentToAppend || !contentToAppend.trim()) {
          return { success: false, output: "content is required for append action and cannot be empty." };
        }
        const gate = await hooks.check("gate:memory:write", { file, content: contentToAppend });
        if (!gate.allowed) {
          return { success: false, output: `Write blocked by gate: ${gate.reason ?? "no reason"}` };
        }
        const existing = await readFile(filePath, "utf-8").catch(() => "");
        const newContent = existing.trimEnd() + "\n" + contentToAppend + "\n";
        await writeFile(filePath, newContent);
        hooks.emit("memory:append", { file, appendLength: contentToAppend.length });
        return { success: true, output: `Appended to ${file}` };
      }
      return { success: false, output: `Invalid action: "${action}". Must be 'read' or 'append'.` };
    } catch (e) {
      return { success: false, output: "", error: formatError(`Failed to ${action} "${file}"`, e) };
    }
  },
};
