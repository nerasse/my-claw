import { readdir, access } from "node:fs/promises";
import { type Tool, type ToolResult, str, strOpt } from "./types.ts";
import { resolveWorkspacePath } from "./workspace.ts";
import { formatError } from "../utils/errors.ts";

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
    const path = str(args, "path");
    if (!path.trim()) {
      return { success: false, output: "path is required and cannot be empty." };
    }
    let resolved: string;
    try {
      resolved = resolveWorkspacePath(path, strOpt(args, "__workspaceDir"));
    } catch (e) {
      return { success: false, output: "", error: String((e as Error).message) };
    }
    try {
      await access(resolved);
    } catch {
      return { success: false, output: `Directory not found: ${resolved}. Check the path exists.` };
    }
    try {
      const entries = await readdir(resolved, { withFileTypes: true });
      if (entries.length === 0) {
        return { success: true, output: "(empty directory)" };
      }
      const output = entries
        .map((e) => `${e.isDirectory() ? "d" : "f"} ${e.name}`)
        .join("\n");
      return { success: true, output };
    } catch (e) {
      return { success: false, output: "", error: formatError(`Failed to list "${resolved}"`, e) };
    }
  },
};
