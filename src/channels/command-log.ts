/**
 * Commands are logged so a session incident can be reconstructed afterwards (a history that
 * vanished could not be attributed to `/new` because nothing recorded the commands). Arguments are
 * part of that record, but some of them are live credentials, so they are masked here rather than
 * at each call site — one place to audit, and no way to forget it in a new one.
 */

// `/claude set-token <token>` (and its `token` alias) carries a subscription token the owner is
// told to delete from the chat right after sending it. It must never reach a log file.
const SENSITIVE_SUBCOMMANDS = new Set(["set-token", "token"]);

export function redactCommandArgs(command: string, args: string): string {
  const trimmed = args.trim();
  if (!trimmed || command !== "claude") return trimmed;

  const parts = trimmed.split(/\s+/);
  const subcommand = parts[0];
  if (!subcommand || !SENSITIVE_SUBCOMMANDS.has(subcommand.toLowerCase())) return trimmed;
  return parts.length > 1 ? `${subcommand} [redacted]` : subcommand;
}
