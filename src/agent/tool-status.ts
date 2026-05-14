export interface ToolCallInfo {
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolCallResult {
  name: string;
  arguments: Record<string, unknown>;
  durationMs: number;
}

export function formatToolStatusVerbose(tools: ToolCallResult[]): string {
  if (!tools.length) return "";
  const lines = tools.map((tc) => {
    const argsStr = JSON.stringify(tc.arguments);
    const display = argsStr.length > 300 ? argsStr.slice(0, 240) + "..." : argsStr;
    return `${tc.name}(${display}) [${tc.durationMs}ms]`;
  });
  return "\n\n```\n" + lines.join("\n") + "\n```\n";
}

export function formatToolStatusCompact(tools: ToolCallResult[]): string {
  if (!tools.length) return "";
  const names = tools.map((tc) => tc.name);
  return "\n\n> " + names.join(", ") + "\n";
}
