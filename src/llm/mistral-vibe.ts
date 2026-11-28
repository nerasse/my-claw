/**
 * The client Mistral Vibe presents, captured from the CLI itself.
 *
 * A plain `api.mistral.ai` call with the same key is refused `402 billing_spend_limit_api_key`
 * (the API key's own budget is a separate, empty pool), while the same call carrying
 * `metadata.call_source: "vibe_code"` is accepted and billed to the Vibe Code allowance. The
 * fingerprint is therefore not cosmetic: it decides which of the two budgets pays, and a request
 * that loses it silently moves every call onto a pool the key may not have.
 *
 * Captured 2026-11-28 with Vibe 3.1.5 through a local TLS proxy that forwarded to the real API.
 * What the CLI sent, and what this module reproduces:
 *
 *   user-agent: mistral-client-python/Mistral-Vibe/3.1.5
 *   authorization: Bearer <MISTRAL_API_KEY>
 *   x-affinity: <uuid, stable for the session>
 *   POST /v1/chat/completions
 *   { model, messages, temperature, stream, metadata, tools, parallel_tool_calls, reasoning_effort }
 *
 * The CLI's own version moves on its release cadence; `MISTRAL_VIBE_CLI_VERSION` in
 * `~/.my-claw/.env` moves the claim without waiting for a my-claw release, the same lever
 * `ANTHROPIC_CLI_VERSION` gives the Claude transport.
 */
import { createHash, randomUUID } from "node:crypto";
import { release } from "node:os";
import { refreshEnvFile } from "../core/config.ts";

export const VIBE_CLIENT = {
  /** The CLI release the capture came from. */
  version: "3.1.5",
  /** How the Python client names itself: package first, product second. */
  userAgent: "mistral-client-python/Mistral-Vibe/3.1.5",
} as const;

/** What the request claims right now, with the `.env` lever applied. */
export function vibeClient(): { version: string; userAgent: string } {
  refreshEnvFile();
  const version = process.env["MISTRAL_VIBE_CLI_VERSION"] || VIBE_CLIENT.version;
  return { version, userAgent: `mistral-client-python/Mistral-Vibe/${version}` };
}

/**
 * A stable, UUID-shaped affinity value for one conversation.
 *
 * Vibe generates a fresh UUID per session and sends the same value as `x-affinity` and as
 * `metadata.session_id`. Deriving it from the conversation key keeps cache affinity across the
 * turns of that conversation, which a fresh value per request would throw away.
 */
export function vibeSessionId(cacheKey: string | undefined): string {
  if (!cacheKey) return randomUUID();
  const digest = createHash("sha256").update(cacheKey).digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

/**
 * The metadata block Vibe attaches to every model call.
 *
 * `call_source` is the one field the billing gate reads (measured: without it the same request is
 * a 402 on the API key's empty pool). The rest describes the client so a support trace sees what
 * the CLI would have said; none of it carries user content.
 */
export function vibeMetadata(sessionId: string): Record<string, string> {
  const client = vibeClient();
  return {
    agent_entrypoint: "programmatic",
    agent_version: client.version,
    client_name: "vibe_programmatic",
    client_version: client.version,
    os: process.platform,
    arch: process.arch === "x64" ? "x86_64" : process.arch,
    os_version: release(),
    version: client.version,
    terminal_emulator: "unknown",
    session_id: sessionId,
    call_type: "main_call",
    call_source: "vibe_code",
    host_kind: "local",
  };
}

/** The headers Vibe's HTTP client adds on top of the JSON body. */
export function vibeHeaders(sessionId: string): Record<string, string> {
  return {
    "user-agent": vibeClient().userAgent,
    "x-affinity": sessionId,
    accept: "text/event-stream",
  };
}
