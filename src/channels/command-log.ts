/**
 * Commands are logged so a session incident can be reconstructed afterwards (a history that
 * vanished could not be attributed to a command because nothing recorded them). Arguments are
 * part of that record, but some of them are live credentials, so they are masked here rather than
 * at each call site — one place to audit, and no way to forget it in a new one.
 */

// `/claude set-token <token>` (and its `token` alias) carries a subscription token the owner is
// told to delete from the chat right after sending it. It must never reach a log file.
//
// `/claude code <code>` carries an OAuth authorization code. Single-use and short-lived, but it is
// exchangeable for a refresh token until it is spent, so it is a credential while it sits in a log.
const SENSITIVE_SUBCOMMANDS = new Set(["set-token", "token", "code"]);

export function redactCommandArgs(command: string, args: string): string {
  const trimmed = args.trim();
  if (!trimmed || command !== "claude") return trimmed;

  const parts = trimmed.split(/\s+/);
  const subcommand = parts[0];
  if (!subcommand || !SENSITIVE_SUBCOMMANDS.has(subcommand.toLowerCase())) return trimmed;
  return parts.length > 1 ? `${subcommand} [redacted]` : subcommand;
}
