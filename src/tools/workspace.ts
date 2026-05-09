import { join } from "node:path";

export function resolveWorkspacePath(inputPath: string, workspaceDir?: string): string {
  const workspace = workspaceDir ?? process.env["MY_CLAW_WORKSPACE"];
  if (!workspace) return inputPath;
  if (inputPath.startsWith("/")) return inputPath;
  return join(workspace, inputPath);
}
