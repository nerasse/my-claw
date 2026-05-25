import { readFile, access } from "node:fs/promises";
import { type Tool, type ToolResult, str, strOpt } from "./types.ts";
import { resolveWorkspacePath } from "./workspace.ts";
import { formatError } from "../utils/errors.ts";
import { hooks } from "../hooks/index.ts";

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
    let resolved: string;
    try {
      resolved = resolveWorkspacePath(str(args, "path"), strOpt(args, "__workspaceDir"));
    } catch (e) {
      return { success: false, output: "", error: String((e as Error).message) };
    }
    try {
      await access(resolved);
    } catch {
      return { success: false, output: `File not found: ${resolved}. Check the path and ensure the file exists.` };
    }
    try {
      const content = await readFile(resolved, "utf-8");
      hooks.emit("tool:file:read", { path: resolved, size: content.length });
      return { success: true, output: content };
    } catch (e) {
      return { success: false, output: "", error: formatError(`Failed to read "${resolved}"`, e) };
    }
  },
};
