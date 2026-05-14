export interface ToolCallInfo {
  name: string;
  arguments: Record<string, unknown>;
}

export function formatToolStatus(toolCalls: ToolCallInfo[]): string {
  if (!toolCalls.length) return "";
  const lines = toolCalls.map((tc) => {
    const argsStr = JSON.stringify(tc.arguments);
    const display = argsStr.length > 300 ? argsStr.slice(0, 240) + "..." : argsStr;
    return `${tc.name}(${display})`;
  });
  return "\n\n```\n" + lines.join("\n") + "\n```\n";
}
