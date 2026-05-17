import { join, resolve } from "node:path";

export function resolveWorkspacePath(inputPath: string, workspaceDir?: string): string {
  const workspace = workspaceDir ?? process.env["MY_CLAW_WORKSPACE"];
  if (!workspace) return inputPath;
  const resolved = inputPath.startsWith("/") ? resolve(inputPath) : resolve(workspace, inputPath);
  if (!resolved.startsWith(workspace + "/") && resolved !== workspace) {
    throw new Error(`Path "${inputPath}" escapes workspace directory.`);
  }
  return resolved;
}
