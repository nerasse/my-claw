/**
 * `/new` is recognized only on its own. Text such as `/new please explain` is a message, not a
 * request to open a thread; matching the no-argument form here keeps that distinction when the
 * message is inspected outside the app adapter.
 */
const META_COMMAND_PATTERN = /^(?:\/(?:help|commands|models?|effort|status|compact|reload(?:-skills)?|verbose|cron|windows|stop|codex|claude|config|skills|agents|mcp|instructions|branches|fork|retry)(?:\b|@[A-Za-z0-9_-]+)|\/new(?:@[A-Za-z0-9_-]+)?)$/;

export function isMetaCommand(text: string): boolean {
  return META_COMMAND_PATTERN.test(text.trim());
}
