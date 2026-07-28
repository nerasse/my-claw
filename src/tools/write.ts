import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { writeFileAtomically } from "../utils/atomic-write.ts";
import { isTracked, snapshot } from "../core/config-store.ts";
import { type Tool, type ToolResult, str, strOpt } from "./types.ts";
import { resolveWorkspacePath } from "./workspace.ts";
import { formatError } from "../utils/errors.ts";
import { hooks } from "../hooks/index.ts";

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
    const path = str(args, "path");
    if (!path.trim()) {
      return { success: false, output: "path is required and cannot be empty." };
    }
    try {
      const resolved = resolveWorkspacePath(path, strOpt(args, "__workspaceDir"));
      await mkdir(dirname(resolved), { recursive: true });
      const content = str(args, "content");
      // The agent edits its own instructions through this tool, so keep the version it is about to
      // replace. Tracked-only: no second list of protected paths to keep in sync.
      if (await isTracked(resolved)) {
        await snapshot(resolved, { origin: "tool", note: "write tool" });
      }
      // Atomic: a torn write to a watched file (SOUL.md, a SKILL.md) is read back by the watcher
      // and looks like corruption rather than an interrupted write.
      await writeFileAtomically(resolved, content);
      hooks.emit("tool:file:write", { path: resolved, size: content.length });
      return { success: true, output: `Written to ${resolved}` };
    } catch (e) {
      return { success: false, output: "", error: formatError(`Failed to write "${path}"`, e) };
    }
  },
};
