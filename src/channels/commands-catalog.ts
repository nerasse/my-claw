/**
 * Shared command catalog. Single source of truth for every channel: telegram registers the
 * bot menu from it, the my-claw-app channel answers `commands.list` with it, and the app
 * renders the slash-menu from the server response.
 */

export interface CommandInfo {
  command: string;
  description: string;
  /**
   * Channels that actually run this command. Absent means all of them. A channel must never
   * advertise what it cannot run, nor quietly run what it does not advertise: the scope is
   * declared here so the menu, the help text and the interception can never drift apart.
   */
  channels?: readonly string[];
}

export const COMMANDS: readonly CommandInfo[] = [
  { command: "new", description: "Start a fresh session" },
  // The app intercepts `/tag` natively (it opens the tags page / tag editor); the other
  // channels get the catalog entry only so the app's slash-menu can complete the command.
  { command: "tag", description: "Model tags: /tag new \"name\"", channels: ["my-claw-app"] },
  { command: "model", description: "Show or change current model, or an agent default: /model <agent>" },
  { command: "models", description: "List available models" },
  { command: "effort", description: "Show or set reasoning effort" },
  { command: "compact", description: "Compact session context" },
  { command: "reload", description: "Reload skills from disk" },
  { command: "verbose", description: "Toggle verbose tool output" },
  { command: "status", description: "Session diagnostics: context, tokens, cost, active runs" },
  { command: "stop", description: "Stop the running agent and its sub-agents" },
  // Deletes the snapshots that /new leaves behind on the chat platforms. The app never makes
  // those: it archives by flagging a conversation, reversibly, from its own menu.
  { command: "archive", description: "Delete archives created by /new", channels: ["telegram"] },
  { command: "cron", description: "List scheduled tasks" },
  { command: "codex", description: "ChatGPT/Codex login: login|status|logout" },
  { command: "claude", description: "Claude subscription: login|set-token|status|logout" },
  { command: "config", description: "Config snapshots: history|diff|rollback" },
  { command: "skills", description: "List skills, optionally for one agent" },
  { command: "agents", description: "List agent types and live sub-agents" },
  { command: "mcp", description: "List MCP servers, optionally for one agent" },
  { command: "instructions", description: "Dump the composed system prompt" },
  { command: "help", description: "List available commands" },
];

export function commandsFor(channel: string): CommandInfo[] {
  return COMMANDS.filter((c) => !c.channels || c.channels.includes(channel));
}

export function getHelpText(channel: string): string {
  return commandsFor(channel)
    .map((c) => `/${c.command} — ${c.description}`)
    .join("\n");
}
