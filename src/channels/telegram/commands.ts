import type { Bot } from "grammy";
import { commandsFor } from "../commands-catalog.ts";

export { COMMANDS, getHelpText, commandsFor } from "../commands-catalog.ts";

export async function registerCommands(bot: Bot): Promise<void> {
  await bot.api.setMyCommands(
    commandsFor("telegram").map((c) => ({ command: c.command, description: c.description })),
  );
}
