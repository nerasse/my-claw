const META_COMMAND_PATTERN = /^\/(?:help|commands|models?|effort|status|clear|archive|new|compact|reload(?:-skills)?|verbose|cron|stop|codex|claude)(?:\b|@)/;

export function isMetaCommand(text: string): boolean {
  return META_COMMAND_PATTERN.test(text.trim());
}
