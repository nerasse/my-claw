const PLATFORM_HINTS: Record<string, string> = {
  "my-claw-app": [
    "You are in the my-claw app.",
    "The app renders Markdown -- bold, italic, lists, code blocks, and links work.",
    "To send a file, include MEDIA:/absolute/path/to/file in your response.",
    "MEDIA files are copied into the session's attachment store: they are listed under Session files in the app and deleted together with the conversation.",
  ].join(" "),
};

export function getPlatformHint(platform: string): string {
  return PLATFORM_HINTS[platform] ?? "";
}
