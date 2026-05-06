export const MATRIX_COMMANDS = [
  { command: "new", description: "Start a fresh session" },
  { command: "model", description: "Show or change current model" },
  { command: "status", description: "Show current status" },
  { command: "clear", description: "Clear session history" },
  { command: "help", description: "List available commands" },
] as const;

export function getMatrixHelpText(): string {
  return MATRIX_COMMANDS.map((c) => `/${c.command} - ${c.description}`).join("\n");
}

export function parseMatrixCommand(text: string): {
  command: string;
  args: string;
} | null {
  const match = /^\/(\w+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return null;
  return {
    command: match[1] ?? "",
    args: match[2] ?? "",
  };
}
