import { arch, hostname, platform, userInfo } from "node:os";
import type { NodeFacts } from "../nodes/types.ts";
import { exposedTools, type NodeClientConfig } from "./config.ts";
import { manifestFor } from "./tools.ts";
import { CLIENT_VERSION } from "./version.ts";

/** The mode the node runs in: root (or SYSTEM on Windows) is the admin install. */
export function isAdminProcess(): boolean {
  if (process.platform === "win32") return (process.env["USERNAME"] ?? "").toLowerCase() === "system";
  return typeof process.getuid === "function" && process.getuid() === 0;
}

function currentUser(): string {
  try {
    return userInfo().username;
  } catch {
    return process.env["USER"] ?? process.env["USERNAME"] ?? "unknown";
  }
}

/**
 * What the node announces about itself, at pairing and on every connect. The tool list follows the
 * config, so the server's agent is generated from what this machine actually exposes.
 */
export function buildFacts(config: NodeClientConfig): NodeFacts {
  return {
    os: platform(),
    arch: arch(),
    hostname: hostname(),
    user: currentUser(),
    mode: isAdminProcess() ? "admin" : "user",
    version: CLIENT_VERSION,
    tools: manifestFor(config),
  };
}

/** Exposed for the hello, so a test can prove the manifest follows the config. */
export function exposedToolNames(config: NodeClientConfig): string[] {
  return exposedTools(config);
}
