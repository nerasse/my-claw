import { mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { writeFileAtomically } from "../utils/atomic-write.ts";
import { isTracked, snapshot } from "../core/config-store.ts";
import { type Tool, type ToolResult, str, strOpt, bool } from "./types.ts";
import { resolveWorkspacePath } from "./workspace.ts";
import { formatError } from "../utils/errors.ts";
import { hooks } from "../hooks/index.ts";

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export const writeTool: Tool = {
  name: "write",
  description: "Create a file. Refuses an existing file unless overwrite is set: use apply_patch to edit one.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute path to the file" },
      content: { type: "string", description: "Content to write" },
      overwrite: {
        type: "boolean",
        description: "Replace a file that already exists. Without it, an existing file is refused: edit it with apply_patch.",
      },
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
      // Rewriting a whole file to change three lines is how a model silently drops the rest of
      // it. An existing file is an edit until stated otherwise, and apply_patch is that edit.
      if (!bool(args, "overwrite", false) && (await exists(resolved))) {
        return {
          success: false,
          output: "",
          error: `${resolved} already exists. Edit it with apply_patch, or pass overwrite: true to replace the whole file.`,
        };
      }
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
