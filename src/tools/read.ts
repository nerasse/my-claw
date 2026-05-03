import { readFile } from "node:fs/promises";
import type { Tool, ToolResult } from "./types.ts";

export const readTool: Tool = {
  name: "read",
  description: "Read a file from the filesystem",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute path to the file" },
    },
    required: ["path"],
  },
  async execute(args): Promise<ToolResult> {
    try {
      const content = await readFile(args["path"] as string, "utf-8");
      return { success: true, output: content };
    } catch (e) {
      return { success: false, output: "", error: String(e) };
    }
  },
};
