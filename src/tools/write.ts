import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Tool, ToolResult } from "./types.ts";

export const writeTool: Tool = {
  name: "write",
  description: "Write content to a file",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute path to the file" },
      content: { type: "string", description: "Content to write" },
    },
    required: ["path", "content"],
  },
  async execute(args): Promise<ToolResult> {
    try {
      await mkdir(dirname(args["path"] as string), { recursive: true });
      await writeFile(args["path"] as string, args["content"] as string);
      return { success: true, output: `Written to ${args["path"]}` };
    } catch (e) {
      return { success: false, output: "", error: String(e) };
    }
  },
};
