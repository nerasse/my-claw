const INJECTION_PATTERNS = [
  /ignore\s+(previous|all|above|prior)\s+instructions/i,
  /do\s+not\s+tell\s+the\s+user/i,
  /system\s+prompt\s+override/i,
  /disregard\s+(your|all|any)\s+(instructions|rules|guidelines)/i,
  /act\s+as\s+(if|though)\s+you\s+(have\s+no|don['']t\s+have)\s+(restrictions|limits|rules)/i,
  /<!--[^>]*(?:ignore|override|system|secret|hidden)[^>]*-->/i,
  /<\s*div\s+style\s*=\s*["'][\s\S]*?display\s*:\s*none/i,
  /translate\s+.*\s+into\s+.*\s+and\s+(execute|run|eval)/i,
  /curl\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i,
  /cat\s+[^\n]*(\.env|credentials|\.netrc|\.pgpass)/i,
];

const INVISIBLE_CHARS = new Set([
  "\u200b",
  "\u200c",
  "\u200d",
  "\u2060",
  "\ufeff",
  "\u202a",
  "\u202b",
  "\u202c",
  "\u202d",
  "\u202e",
]);

export function scanForInjection(content: string, filename: string): string {
  const reasons: string[] = [];

  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(content)) {
      reasons.push(`pattern: ${pattern.source}`);
    }
  }

  for (const char of content) {
    if (INVISIBLE_CHARS.has(char)) {
      reasons.push(
        `unicode: U+${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}`,
      );
    }
  }

  if (reasons.length > 0) {
    return `[BLOCKED: ${filename} contained potential prompt injection (${reasons.join(", ")})]`;
  }

  return content;
}
