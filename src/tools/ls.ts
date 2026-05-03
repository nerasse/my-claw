import { readdir } from "node:fs/promises";
import type { Tool, ToolResult } from "./types.ts";

export const lsTool: Tool = {
  name: "ls",
  description: "List directory contents",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory path" },
    },
    required: ["path"],
  },
  async execute(args): Promise<ToolResult> {
    try {
      const entries = await readdir(args["path"] as string, { withFileTypes: true });
      const output = entries
        .map((e) => `${e.isDirectory() ? "d" : "f"} ${e.name}`)
        .join("\n");
      return { success: true, output };
    } catch (e) {
      return { success: false, output: "", error: String(e) };
    }
  },
};
