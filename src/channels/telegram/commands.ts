import type { Bot } from "grammy";
import { COMMANDS, getHelpText } from "../commands-catalog.ts";

export { COMMANDS, getHelpText } from "../commands-catalog.ts";

export async function registerCommands(bot: Bot): Promise<void> {
  await bot.api.setMyCommands(
    COMMANDS.map((c) => ({ command: c.command, description: c.description })),
  );
}
