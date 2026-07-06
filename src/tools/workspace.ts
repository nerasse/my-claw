import { join, resolve } from "node:path";

export function resolveWorkspacePath(inputPath: string, workspaceDir?: string): string {
  const rawWorkspace = workspaceDir ?? process.env["MY_CLAW_WORKSPACE"];
  if (!rawWorkspace) return inputPath;
  // Normalize the workspace first: a trailing slash (e.g. "/ws/sub/") would make the boundary
  // check "/ws/sub//" and reject every relative path for that sub-agent.
  const workspace = resolve(rawWorkspace);
  const resolved = inputPath.startsWith("/") ? resolve(inputPath) : resolve(workspace, inputPath);
  if (!resolved.startsWith(workspace + "/") && resolved !== workspace) {
    throw new Error(`Path "${inputPath}" escapes workspace directory.`);
  }
  return resolved;
}
