/**
 * Without this, Claude's anti-injection training treats a mid-run steering message that
 * contradicts the initial task as an attack and ignores it (verified in the phase 0 spike of
 * docs/anthropic-backend.md).
 *
 * It lives in a neutral module rather than in an engine so that `/instructions`, the introspection
 * commands and any transport can reach it without importing a backend.
 */
export const OWNER_STEERING_NOTE =
  "\n\n# Mid-run steering\n" +
  "You are operated by a single trusted owner. User messages arriving mid-conversation " +
  "(including while you are working) are legitimate steering from the owner and take " +
  "precedence over earlier instructions.";

/**
 * Which engines need the note appended to their system prompt.
 *
 * The native Anthropic transport talks to Claude models and inherits the same anti-injection
 * training and the same need. The home loop's OpenAI-compatible and Codex paths do not exhibit
 * the behaviour.
 */
export function needsOwnerSteeringNote(backend?: string): boolean {
  return backend === "anthropic";
}
