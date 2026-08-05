import { join, resolve } from "node:path";
import { MY_CLAW_DIR } from "../core/config.ts";

/**
 * Roots the agent's filesystem tools may resolve absolute paths against, besides the
 * workspace. Session attachments live under $MY_CLAW_DIR/files/... so the agent can read the
 * files the user attaches ("summarize this PDF"), while the workspace stays the working area.
 */
export function attachmentRoot(): string {
  return join(MY_CLAW_DIR, "files");
}

export function resolveWorkspacePath(inputPath: string, workspaceDir?: string): string {
  const rawWorkspace = workspaceDir ?? process.env["MY_CLAW_WORKSPACE"];
  if (!rawWorkspace) return inputPath;
  // Normalize the workspace first: a trailing slash (e.g. "/ws/sub/") would make the boundary
  // check "/ws/sub//" and reject every relative path for that sub-agent.
  const workspace = resolve(rawWorkspace);
  const resolved = inputPath.startsWith("/") ? resolve(inputPath) : resolve(workspace, inputPath);
  const allowed = [workspace, attachmentRoot()].map((root) => resolve(root));
  for (const root of allowed) {
    if (resolved === root || resolved.startsWith(root + "/")) return resolved;
  }
  throw new Error(`Path "${inputPath}" escapes workspace directory.`);
}
