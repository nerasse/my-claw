import { readFile, access } from "node:fs/promises";
import { type Tool, type ToolResult, str, strOpt } from "./types.ts";
import { resolveReadOnlyPath } from "./workspace.ts";
import { formatError } from "../utils/errors.ts";
import { hooks } from "../hooks/index.ts";

const MAX_READ_CHARS = 100_000;

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
      resolved = resolveReadOnlyPath(str(args, "path"), strOpt(args, "__workspaceDir"), strOpt(args, "__sessionId"));
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
      // Cap like the other text tools: one read of a huge log/file must not poison the session.
      if (content.length > MAX_READ_CHARS) {
        return { success: true, output: `${content.slice(0, MAX_READ_CHARS)}\n[output truncated at ${MAX_READ_CHARS} chars; file is ${content.length} chars]` };
      }
      return { success: true, output: content };
    } catch (e) {
      return { success: false, output: "", error: formatError(`Failed to read "${resolved}"`, e) };
    }
  },
};
