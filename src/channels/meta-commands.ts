/**
 * `/new` and `/archive` are deliberately absent. They came from Telegram and Matrix, where a
 * conversation was a room and starting a fresh one meant emptying it; the app makes a new thread
 * instead, so the only thing `/new` did here was archive a live conversation out from under its
 * owner. It did exactly that on 2026-08-23: a message opening with the words "/new doit etre
 * supprime" was read as the command, and 178 turns left the thread mid-task.
 */
const META_COMMAND_PATTERN = /^\/(?:help|commands|models?|effort|status|compact|reload(?:-skills)?|verbose|cron|stop|codex|claude|config|skills|agents|mcp|instructions|branches|fork|retry)(?:\b|@)/;

export function isMetaCommand(text: string): boolean {
  return META_COMMAND_PATTERN.test(text.trim());
}
