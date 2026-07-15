export const MATRIX_COMMANDS = [
  { command: "new", description: "Start a fresh session" },
  { command: "model", description: "Show model menu or change current model" },
  { command: "models", description: "List available models" },
  { command: "effort", description: "Show or set reasoning effort" },
  { command: "compact", description: "Compact session context" },
  { command: "reload", description: "Reload skills from disk" },
  { command: "reload-skills", description: "Reload skills from disk" },
  { command: "verbose", description: "Toggle verbose tool output" },
  { command: "status", description: "Show current status" },
  { command: "stop", description: "Stop the running agent and its sub-agents" },
  { command: "clear", description: "Clear session history" },
  { command: "archive", description: "Delete archives created by /new" },
  { command: "cron", description: "List scheduled tasks" },
  { command: "help", description: "List available commands" },
  { command: "commands", description: "List available commands" },
] as const;

export function getMatrixHelpText(): string {
  return [
    "Matrix commands:",
    ...MATRIX_COMMANDS.map((c) => `/${c.command} - ${c.description}`),
    "",
    "Tips:",
    "- Reply with a menu number when model or approval menus are shown",
    "- Reactions work well for quick choices; replies work for every numbered option",
    "- Use `/model` with no args to reopen the model menu",
    "- Use `/models` to browse the configured model list",
    "- Use `/commands` to list commands explicitly",
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
