import type { Bot } from "grammy";

export const COMMANDS = [
  { command: "new", description: "Start a fresh session" },
  { command: "model", description: "Show or change current model, or an agent default: /model <agent>" },
  { command: "models", description: "List available models" },
  { command: "effort", description: "Show or set reasoning effort" },
  { command: "compact", description: "Compact session context" },
  { command: "reload", description: "Reload skills from disk" },
  { command: "verbose", description: "Toggle verbose tool output" },
  { command: "status", description: "Show current status" },
  { command: "stop", description: "Stop the running agent and its sub-agents" },
  { command: "clear", description: "Clear session history" },
  { command: "archive", description: "Delete archives created by /new" },
  { command: "cron", description: "List scheduled tasks" },
  { command: "codex", description: "ChatGPT/Codex login: login|status|logout" },
  { command: "claude", description: "Claude subscription: login|set-token|status|logout" },
  { command: "config", description: "Config snapshots: history|diff|rollback" },
  { command: "skills", description: "List skills, optionally for one agent" },
  { command: "agents", description: "List agent types and live sub-agents" },
  { command: "mcp", description: "List MCP servers, optionally for one agent" },
  { command: "instructions", description: "Dump the composed system prompt" },
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
