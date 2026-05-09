import { readFile } from "node:fs/promises";
import type { Tool, ToolResult } from "./types.ts";
import { resolveWorkspacePath } from "./workspace.ts";

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
      const content = await readFile(resolveWorkspacePath(args["path"] as string, args["__workspaceDir"] as string | undefined), "utf-8");
      return { success: true, output: content };
    } catch (e) {
      return { success: false, output: "", error: String(e) };
    }
  },
};
