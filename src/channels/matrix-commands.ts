export const MATRIX_COMMANDS = [
  { command: "new", description: "Start a fresh session" },
  { command: "model", description: "Show model menu or change current model" },
  { command: "status", description: "Show current status" },
  { command: "clear", description: "Clear session history" },
  { command: "archive", description: "Delete archives created by /new" },
  { command: "help", description: "List available commands" },
] as const;

export function getMatrixHelpText(): string {
  return [
    "Matrix commands:",
    ...MATRIX_COMMANDS.map((c) => `/${c.command} - ${c.description}`),
    "",
    "Tips:",
    "- Reply with a menu number when model or approval menus are shown",
    "- React to menu messages if your client makes reactions easier than replies",
    "- Use `/model` with no args to reopen the model menu",
  ].join("\n");
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
