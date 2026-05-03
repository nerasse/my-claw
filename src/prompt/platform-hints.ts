const PLATFORM_HINTS: Record<string, string> = {
  telegram: [
    "You are on Telegram.",
    "Supported markdown: **bold**, *italic*, ~~strikethrough~~, `inline code`, ```code blocks```, [links](url).",
    "Telegram has NO table syntax -- use bullet lists or key: value pairs instead.",
    "To send a file, include MEDIA:/absolute/path/to/file in your response.",
    "Images (.png, .jpg, .webp) appear as photos, audio (.ogg) as voice, video (.mp4) inline.",
  ].join(" "),

  matrix: [
    "You are in a Matrix room.",
    "Matrix renders Markdown -- bold, italic, code blocks, links, and tables work.",
    "To send a file, include MEDIA:/absolute/path/to/file in your response.",
    "Images (.jpg, .png, .webp) are sent inline, audio as voice messages, video inline.",
  ].join(" "),
};

export function getPlatformHint(platform: string): string {
  return PLATFORM_HINTS[platform] ?? "";
}
