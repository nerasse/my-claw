export const MATRIX_COMMANDS = [
  { command: "new", description: "Start a fresh session" },
  { command: "model", description: "Show model menu or change current model, or an agent default: /model <agent>" },
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
  { command: "codex", description: "ChatGPT/Codex login: login|status|logout" },
  { command: "claude", description: "Claude subscription: login|set-token|status|logout" },
  { command: "config", description: "Config snapshots: history|diff|rollback" },
  { command: "skills", description: "List skills, optionally for one agent" },
  { command: "agents", description: "List agent types and live sub-agents" },
  { command: "mcp", description: "List MCP servers, optionally for one agent" },
  { command: "instructions", description: "Dump the composed system prompt" },
  { command: "help", description: "List available commands" },
  { command: "commands", description: "List available commands" },
] as const;

export function getMatrixHelpText(): string {
  return [
    "Matrix commands:",
    ...MATRIX_COMMANDS.map((c) => `/${c.command} - ${c.description}`),
    "",
    "Tips:",
    "- Reply with a menu number, or the letter shown past the tenth option",
    "- Reactions work well for quick choices; replies work for every numbered option",
    "- Use `/model` with no args to reopen the model menu",
    "- Use `/model <agent>` (orchestrator, general, research, cron) to set that agent's default in config",
    "- Use `/models` to browse the configured model list",
    "- Use `/commands` to list commands explicitly",
  ].join("\n");
}

export function parseMatrixCommand(text: string): {
  command: string;
  args: string;
} | null {
  // Hyphens are part of a command name: `\w+` alone silently dropped `/reload-skills`, which is
  // advertised above, matched by META_COMMAND_PATTERN and handled in the switch, yet reached the LLM
  // as prose instead. The leading `\w` rejects `/-`, and the trailing `$` keeps a path like
  // `/home/user/x` out of the command path since `/` is not part of a name.
  const match = /^\/(\w[\w-]*)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return null;
  return {
    command: match[1] ?? "",
    args: match[2] ?? "",
  };
}
