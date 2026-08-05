export interface ToolCallInfo {
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolCallResult {
  name: string;
  arguments: Record<string, unknown>;
  /** Absent when the call is replayed from a session file written before timings were persisted. */
  durationMs?: number;
  /** Result handed to the model. Channels that render tool cards (mobile) show it; text channels ignore it. */
  output?: string;
  ok?: boolean;
}

export function formatToolStatusVerbose(tools: ToolCallResult[]): string {
  if (!tools.length) return "";
  const lines = tools.map((tc) => {
    const argsStr = JSON.stringify(tc.arguments);
    const display = argsStr.length > 300 ? argsStr.slice(0, 240) + "..." : argsStr;
    const timing = typeof tc.durationMs === "number" ? ` [${tc.durationMs}ms]` : "";
    return `${tc.name}(${display})${timing}`;
  });
  return "\n\n```\n" + lines.join("\n") + "\n```\n";
}

export function formatToolStatusCompact(tools: ToolCallResult[]): string {
  if (!tools.length) return "";
  const names = tools.map((tc) => tc.name);
  return "\n\n> " + names.join(", ") + "\n";
}
