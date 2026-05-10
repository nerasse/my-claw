import type { Bot } from "grammy";

export const COMMANDS = [
  { command: "new", description: "Start a fresh session" },
  { command: "model", description: "Show or change current model" },
  { command: "compact", description: "Compact session context" },
  { command: "status", description: "Show current status" },
  { command: "clear", description: "Clear session history" },
  { command: "archive", description: "Delete archives created by /new" },
  { command: "help", description: "List available commands" },
] as const;

export function getHelpText(): string {
  return COMMANDS.map((c) => `/${c.command} — ${c.description}`).join("\n");
}

export async function registerCommands(bot: Bot): Promise<void> {
  await bot.api.setMyCommands(
    COMMANDS.map((c) => ({ command: c.command, description: c.description })),
  );
}
