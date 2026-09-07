/**
 * Who is calling, and which conversation is calling -- docs/session-affinity.md.
 *
 * A router that fans one API out to many backends wants the requests of one conversation to keep
 * landing on the same one: that is where the prompt prefix is already cached. OpenCode Go asks for
 * exactly that and refuses a request without it outright (`HTTP 400 -- Request is missing
 * x-opencode-session and cannot be routed efficiently`, https://opencode.ai/docs/go/), and asks a
 * client to name itself rather than let the HTTP library do it.
 *
 * The value is a digest of the session id, not the id itself. Routing and cache affinity need it
 * stable, not readable, and the id carries the owner's device and thread.
 */

import { createHash } from "node:crypto";
import { readAppVersion } from "../core/diagnostics.ts";

const OPENCODE_HOST = "opencode.ai";

/** The name my-claw goes by on the wire, resolved once. */
export async function userAgent(): Promise<string> {
  return `my-claw/${await readAppVersion()}`;
}

export function sessionAffinityHeaders(
  baseUrl: string,
  sessionKey: string | undefined,
  ua: string,
): Record<string, string> {
  const headers: Record<string, string> = { "User-Agent": ua };
  if (!sessionKey) return headers;
  const affinity = createHash("sha256").update(sessionKey).digest("hex").slice(0, 32);
  if (isOpencode(baseUrl)) {
    headers["x-opencode-session"] = affinity;
    headers["x-opencode-client"] = "my-claw";
    return headers;
  }
  // What the reference client sends to every other provider: two spellings of the same idea,
  // because the header a proxy reads is not standardised.
  headers["x-session-affinity"] = affinity;
  headers["X-Session-Id"] = affinity;
  return headers;
}

function isOpencode(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname;
    return host === OPENCODE_HOST || host.endsWith(`.${OPENCODE_HOST}`);
  } catch {
    return false;
  }
}
