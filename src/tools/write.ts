import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Tool, ToolResult } from "./types.ts";
import { resolveWorkspacePath } from "./workspace.ts";

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
      const resolved = resolveWorkspacePath(args["path"] as string);
      await mkdir(dirname(resolved), { recursive: true });
      await writeFile(resolved, args["content"] as string);
      return { success: true, output: `Written to ${resolved}` };
    } catch (e) {
      return { success: false, output: "", error: String(e) };
    }
  },
};
