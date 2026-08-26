import { basename, dirname, join, resolve, sep } from "node:path";
import { realpathSync } from "node:fs";
import { MY_CLAW_DIR } from "../core/config.ts";
import { toolOutputDir } from "../sessions/tool-output.ts";

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

/**
 * The path with every symlink on the way to it already followed, including when the leaf does not
 * exist yet.
 *
 * `realpathSync` refuses a missing file, and a containment check run on the textual path instead is
 * not a containment check: a link on any *directory* of the way out is enough to leave the
 * boundary, and testing only the leaf with `lstat` misses every one of them. So the deepest
 * ancestor that does exist is resolved for real, and the components below it are appended to it.
 */
function throughLinks(target: string): string {
  let head = target;
  const tail: string[] = [];
  for (;;) {
    try {
      return resolve(realpathSync(head), ...tail);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      const parent = dirname(head);
      // A root that does not resolve: nothing above can be a link, so the textual form is final.
      if (parent === head) return target;
      tail.unshift(basename(head));
      head = parent;
    }
  }
}

/**
 * A path for reading only, which may also name a file in *this* session's tool output.
 *
 * `read` and `search` use this; the writing tools must not. The store is a journal of what a run
 * produced -- an elided result names its file so the detail is a read rather than a re-run
 * (docs/prompt-immutable.md), and a journal that can be edited is not evidence of anything.
 *
 * Widening a sandbox is worth stating plainly. Reachable: the tool-output directory of the session
 * making the call. Not reachable: another session's, anything above either directory, and anything
 * a symlink points at from outside -- `..` because the path is resolved before it is compared, and
 * links because both sides of that comparison have been through `realpath`.
 */
export function resolveReadOnlyPath(inputPath: string, workspaceDir?: string, sessionId?: string): string {
  try {
    return resolveWorkspacePath(inputPath, workspaceDir);
  } catch (escaped) {
    if (!sessionId) throw escaped;

    const rawWorkspace = workspaceDir ?? process.env["MY_CLAW_WORKSPACE"];
    const workspace = rawWorkspace ? resolve(rawWorkspace) : undefined;
    const asked = inputPath.startsWith("/")
      ? resolve(inputPath)
      : workspace
        ? resolve(workspace, inputPath)
        : resolve(inputPath);

    // The boundary goes through `realpath` too: MY_CLAW_DIR itself is a symlink on some installs,
    // and comparing a resolved path against an unresolved boundary never matches.
    const boundary = throughLinks(toolOutputDir(sessionId));
    const real = throughLinks(asked);
    if (real === boundary || real.startsWith(boundary + sep)) return real;

    throw escaped;
  }
}
