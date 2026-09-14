import { join, resolve } from "node:path";
import { MY_CLAW_DIR } from "../core/config.ts";

/**
 * Where the files the user attaches live: under $MY_CLAW_DIR/files/..., outside any workspace.
 * `src/utils/media.ts` sweeps that root, and serving a session's attachments reads from it.
 */
export function attachmentRoot(): string {
  return join(MY_CLAW_DIR, "files");
}

/**
 * A tool path resolved: absolute paths as they are, relative ones against the workspace.
 *
 * There is no fence here. `bash` never had one -- it spawns in the workspace and takes any
 * absolute path in its command -- so a boundary only the other tools obeyed turned "write this
 * file" into an error the agent worked around by shelling out, and prevented nothing (2026-09-14:
 * a sub-agent denied /tmp/steal_run.sh wrote it with `cat >` one call later).
 */
export function resolveWorkspacePath(inputPath: string, workspaceDir?: string): string {
  const rawWorkspace = workspaceDir ?? process.env["MY_CLAW_WORKSPACE"];
  const workspace = rawWorkspace ? resolve(rawWorkspace) : process.cwd();
  return inputPath.startsWith("/") ? resolve(inputPath) : resolve(workspace, inputPath);
}
