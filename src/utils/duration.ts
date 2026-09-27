const DURATION_RE = /^(\d+(?:\.\d+)?)\s*(s|sec|secs?|seconds?|m|min|mins?|minutes?|h|hr|hrs?|hours?|d|days?)$/i;

/**
 * A duration as the owner writes one in config or a tool call: `90s`, `30m`, `72h`, `7d`. A bare
 * number is milliseconds, the unit every other config value is in. Throws on anything else: a
 * duration that silently became zero is how a reservation expires the moment it is made.
 */
export function parseDurationMs(input: string | number): number {
  if (typeof input === "number") {
    if (!Number.isFinite(input) || input < 0) throw new Error(`Invalid duration: ${input}`);
    return input;
  }
  const match = DURATION_RE.exec(input.trim());
  if (!match) throw new Error(`Cannot read "${input}" as a duration. Use a number and a unit: 30m, 72h, 7d.`);
  const value = Number(match[1]);
  const unit = match[2]!.toLowerCase();
  const factor = unit.startsWith("s") ? 1000 : unit.startsWith("m") ? 60_000 : unit.startsWith("h") ? 3_600_000 : 86_400_000;
  return Math.round(value * factor);
}

/** The same duration read back: the largest unit that keeps it short. */
export function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  if (minutes < 60) return `${minutes} min`;
  const hours = minutes / 60;
  if (hours < 48) return Number.isInteger(hours) ? `${hours} h` : `${Math.floor(hours)} h ${minutes % 60} min`;
  const days = hours / 24;
  return Number.isInteger(days) ? `${days} d` : `${Math.floor(days)} d ${Math.round(hours % 24)} h`;
}
