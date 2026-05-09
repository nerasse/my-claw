import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Tool, ToolResult } from "./types.ts";
import { resolveWorkspacePath } from "./workspace.ts";
import { formatError } from "../utils/errors.ts";

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
    const path = args["path"] as string;
    if (!path || !path.trim()) {
      return { success: false, output: "path is required and cannot be empty." };
    }
    try {
      const resolved = resolveWorkspacePath(path, args["__workspaceDir"] as string | undefined);
      await mkdir(dirname(resolved), { recursive: true });
      await writeFile(resolved, args["content"] as string);
      return { success: true, output: `Written to ${resolved}` };
    } catch (e) {
      return { success: false, output: "", error: formatError(`Failed to write "${path}"`, e) };
    }
  },
};
