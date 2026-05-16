import { readFile, access } from "node:fs/promises";
import { type Tool, type ToolResult, str, strOpt } from "./types.ts";
import { resolveWorkspacePath } from "./workspace.ts";
import { formatError } from "../utils/errors.ts";

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
    const resolved = resolveWorkspacePath(str(args, "path"), strOpt(args, "__workspaceDir"));
    try {
      await access(resolved);
    } catch {
      return { success: false, output: `File not found: ${resolved}. Check the path and ensure the file exists.` };
    }
    try {
      const content = await readFile(resolved, "utf-8");
      return { success: true, output: content };
    } catch (e) {
      return { success: false, output: "", error: formatError(`Failed to read "${resolved}"`, e) };
    }
  },
};
