const META_COMMAND_PATTERN = /^\/(?:help|commands|models?|status|clear|archive|new|compact|reload(?:-skills)?|verbose)(?:\b|@)/;

export function isMetaCommand(text: string): boolean {
  return META_COMMAND_PATTERN.test(text.trim());
}
