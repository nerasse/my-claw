export function errorLogData(err: unknown): unknown {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack };
  }
  return String(err);
}

/**
 * The one-line form a channel puts on screen when a run dies. Bounded, because an API error can
 * carry a whole response body and this ends up in a chat bubble and in a session file.
 */
export function briefError(err: unknown, limit = 200): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.slice(0, limit);
}

/**
 * A provider failure as a note can say it: one short sentence, no payload.
 *
 * A transport error carries the provider's whole HTTP answer -- status, JSON body and the URL its
 * billing page lives at -- which is what a bug report needs and what nobody reading a thread can
 * use. The notes drawn above an answer carried it verbatim, so a fallback read as
 * `HTTP 429 -- {"error":"You've exceeded your subscription rate limits. Upgrade, or try again…`
 * (owner, 2026-11-14: "horrible l'ui des erreurs").
 *
 * The status is what means something at a glance, and the sentence the provider wrote is the
 * explanation; the rest is dropped here and kept in the log, where the raw error still goes.
 */
export function noticeReason(err: unknown, limit = 120): string {
  const raw = err instanceof Error ? err.message : String(err);
  const status = /\bHTTP (\d{3})\b/.exec(raw)?.[1];
  const said = saidIn(raw) ?? raw;
  const one = firstSentence(said);
  const bounded = one.length > limit ? `${one.slice(0, limit - 1).trimEnd()}…` : one;
  return status ? `${status} · ${bounded}` : bounded;
}

/** The sentence a provider wrote, taken out of whatever envelope it came in. */
function saidIn(raw: string): string | undefined {
  const json = /\{[\s\S]*\}/.exec(raw);
  if (!json) {
    // `Anthropic request failed: HTTP 429 — rate limited` has no body at all.
    return /(?:HTTP \d{3}\s*[—:-]\s*)(.+)$/.exec(raw)?.[1];
  }
  try {
    const parsed = JSON.parse(json[0]) as { error?: { message?: unknown } | string; message?: unknown };
    const said = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message ?? parsed.message;
    return typeof said === 'string' && said.trim() ? said : undefined;
  } catch {
    // A body that is not JSON is text, and the text is the answer.
    return undefined;
  }
}

/** Up to the first full stop or semicolon: one clause, on one line. */
function firstSentence(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const cut = /\.\s|;\s/.exec(flat);
  if (cut && cut.index > 0) return flat.slice(0, cut.index).replace(/[.;]+$/, '');
  return flat.replace(/\.$/, '');
}

export function formatError(context: string, rawError: unknown): string {
  const msg = rawError instanceof Error ? rawError.message : String(rawError);

  if (msg.includes("ENOENT") || msg.includes("no such file")) {
    return `${context}: file or directory not found. Check the path exists.`;
  }
  if (msg.includes("EACCES") || msg.includes("permission denied")) {
    return `${context}: permission denied. Check file permissions or use a different path.`;
  }
  if (msg.includes("ENOTDIR") || msg.includes("not a directory")) {
    return `${context}: path is a file, not a directory. Use a directory path.`;
  }
  if (msg.includes("EISDIR") || msg.includes("is a directory")) {
    return `${context}: path is a directory, not a file. Use a file path.`;
  }
  if (msg.includes("EEXIST")) {
    return `${context}: already exists.`;
  }
  if (msg.includes("ENOTEMPTY")) {
    return `${context}: directory not empty.`;
  }
  if (msg.includes("ETIMEDOUT") || msg.includes("timeout")) {
    return `${context}: operation timed out.`;
  }
  if (msg.includes("ECONNREFUSED")) {
    return `${context}: connection refused. Check the server is running.`;
  }
  if (msg.includes("ECONNRESET")) {
    return `${context}: connection reset. Retry or check network.`;
  }
  if (msg.includes("ENOTFOUND")) {
    return `${context}: host not found. Check the URL or hostname.`;
  }

  return `${context}: ${msg}`;
}
