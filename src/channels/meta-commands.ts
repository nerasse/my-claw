const META_COMMAND_PATTERN = /^\/(?:help|commands|models?|effort|status|archive|new|compact|reload(?:-skills)?|verbose|cron|stop|codex|claude|config|skills|agents|mcp|instructions)(?:\b|@)/;

export function isMetaCommand(text: string): boolean {
  return META_COMMAND_PATTERN.test(text.trim());
}
