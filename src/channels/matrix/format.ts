import MarkdownIt from "markdown-it";

const md = new MarkdownIt({ html: false, linkify: true, breaks: true, typographer: false });
md.enable("strikethrough");
md.enable("table");

type MatrixEventContent = Record<string, unknown>;

export interface MatrixMentions {
  room?: boolean;
  user_ids?: string[];
}

const MATRIX_USER_MENTION_RE = /(^|[^A-Za-z0-9_])(@[A-Za-z0-9._=+\-/]+:(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(?::\d+)?)/g;
const HTML_ENTITY_REPLACEMENTS: Readonly<Record<string, string>> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: '"',
};
const MAX_UNICODE_SCALAR_VALUE = 0x10ffff;

function decodeNumericHtmlEntity(match: string, rawValue: string, radix: 10 | 16): string {
  const codePoint = Number.parseInt(rawValue, radix);
  if (
    !Number.isSafeInteger(codePoint) ||
    codePoint < 0 ||
    codePoint > MAX_UNICODE_SCALAR_VALUE ||
    (codePoint >= 0xd800 && codePoint <= 0xdfff)
  ) {
    return match;
  }
  return String.fromCodePoint(codePoint);
}

function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|\w+);/gi, (match, entity: string) => {
    const normalized = entity.trim().toLowerCase();
    if (normalized.startsWith("#x")) {
      return decodeNumericHtmlEntity(match, normalized.slice(2), 16);
    }
    if (normalized.startsWith("#")) {
      return decodeNumericHtmlEntity(match, normalized.slice(1), 10);
    }
    return HTML_ENTITY_REPLACEMENTS[normalized] ?? match;
  });
}

function normalizeVisibleMatrixText(value: string): string {
  return decodeHtmlEntities(
    value.replace(/<[^>]+>/g, " ").replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g, ""),
  )
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeMentionCandidate(value: string): string {
  return normalizeVisibleMatrixText(value).toLowerCase();
}

function readRawMatrixMentions(content: MatrixEventContent): MatrixMentions | undefined {
  const raw = content["m.mentions"];
  if (!raw || typeof raw !== "object") return undefined;

  const mentions = raw as { room?: unknown; user_ids?: unknown };
  const userIds = Array.isArray(mentions.user_ids)
    ? mentions.user_ids.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : undefined;
  const room = mentions.room === true ? true : undefined;

  if (!room && (!userIds || userIds.length === 0)) return undefined;
  return { room, user_ids: userIds };
}

function resolveMatrixUserLocalpart(userId?: string): string | undefined {
  const trimmed = userId?.trim();
  if (!trimmed?.startsWith("@")) return undefined;

  const separator = trimmed.indexOf(":");
  if (separator <= 1) return undefined;

  return trimmed.slice(1, separator).trim() || undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function prefixedMentionCandidate(value?: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed.startsWith("@") ? trimmed : `@${trimmed}`;
}

function resolveMatrixMentionCandidates(params: {
  userId?: string;
  displayName?: string;
}): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();

  const append = (candidate?: string) => {
    const trimmed = candidate?.trim();
    if (!trimmed) return;

    const normalized = normalizeMentionCandidate(trimmed);
    if (!normalized || seen.has(normalized)) return;

    seen.add(normalized);
    candidates.push(trimmed);
  };

  append(params.userId);
  append(prefixedMentionCandidate(resolveMatrixUserLocalpart(params.userId)));
  append(params.displayName);
  append(prefixedMentionCandidate(params.displayName));

  return candidates;
}

function textContainsMention(text: string, candidates: string[]): boolean {
  return candidates.some((candidate) => {
    const pattern = new RegExp(`(^|[^A-Za-z0-9_])${escapeRegExp(candidate)}(?=$|[^A-Za-z0-9_])`, "i");
    return pattern.test(text);
  });
}

function visibleLabelMatchesMention(label: string, candidates: string[]): boolean {
  const normalized = normalizeMentionCandidate(label);
  if (!normalized) return false;

  return candidates.some((candidate) => normalizeMentionCandidate(candidate) === normalized);
}

function checkFormattedBodyMention(params: {
  formattedBody?: string;
  userId?: string;
  candidates: string[];
}): boolean {
  const formattedBody = params.formattedBody;
  const userId = params.userId?.trim();
  if (!formattedBody || !userId) return false;

  const anchorPattern = /<a\b[^>]*href=(["'])(https:\/\/matrix\.to\/#[^"']+)\1[^>]*>(.*?)<\/a>/gis;
  for (const match of formattedBody.matchAll(anchorPattern)) {
    const href = match[2];
    const visibleLabel = match[3] ?? "";
    if (!href) continue;

    try {
      const parsed = new URL(href);
      const fragmentTarget = decodeURIComponent(parsed.hash.replace(/^#\/?/, "").trim());
      if (fragmentTarget !== userId) continue;
      if (visibleLabelMatchesMention(visibleLabel, params.candidates)) return true;
    } catch {
      continue;
    }
  }

  return false;
}

function hasVisibleRoomMention(value?: string): boolean {
  return /(^|[^a-z0-9_])@room\b/i.test(normalizeVisibleMatrixText(value ?? ""));
}

export function markdownToMatrixHtml(markdown: string): string {
  return md.render(markdown ?? "").trimEnd();
}

export function stripMatrixHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"');
}

export function extractMatrixMentions(text: string): MatrixMentions {
  const userIds = new Set<string>();
  let room = false;

  for (const match of text.matchAll(MATRIX_USER_MENTION_RE)) {
    const userId = match[2]?.trim();
    if (userId) userIds.add(userId);
  }

  if (/(^|\s)@room(?=\s|$|[.,!?;:])/i.test(text)) {
    room = true;
  }

  return {
    room: room || undefined,
    user_ids: userIds.size > 0 ? [...userIds] : undefined,
  };
}

export function stripMatrixMentionPrefix(params: {
  text: string;
  userId?: string;
  displayName?: string;
}): string {
  for (const candidate of resolveMatrixMentionCandidates(params)) {
    const escaped = escapeRegExp(candidate);
    const stripped = params.text.replace(
      new RegExp(`^\\s*${escaped}(?:\\s*[:,])?(?:\\s+|$)`, "i"),
      "",
    );
    if (stripped !== params.text) {
      return stripped;
    }
  }

  return params.text;
}

export function resolveInboundMatrixMentions(params: {
  content: MatrixEventContent;
  text: string;
  userId?: string;
  displayName?: string;
}): {
  mentions?: MatrixMentions;
  mentionedBot: boolean;
  mentionedRoom: boolean;
  hasExplicitMention: boolean;
} {
  const mentions = readRawMatrixMentions(params.content);
  const candidates = resolveMatrixMentionCandidates({
    userId: params.userId,
    displayName: params.displayName,
  });
  const textMentioned = textContainsMention(params.text, candidates);
  const formattedBodyMentioned = checkFormattedBodyMention({
    formattedBody:
      typeof params.content.formatted_body === "string" ? params.content.formatted_body : undefined,
    userId: params.userId,
    candidates,
  });
  const visibleRoomMention =
    hasVisibleRoomMention(params.text) ||
    hasVisibleRoomMention(
      typeof params.content.formatted_body === "string" ? params.content.formatted_body : undefined,
    );

  const metadataBackedUserMention = Boolean(
    params.userId &&
      mentions?.user_ids?.includes(params.userId) &&
      (textMentioned || formattedBodyMentioned),
  );
  const metadataBackedRoomMention = Boolean(mentions?.room) && visibleRoomMention;
  const mentionedRoom = visibleRoomMention || metadataBackedRoomMention;
  const mentionedUser = textMentioned || formattedBodyMentioned || metadataBackedUserMention;
  const hasExplicitMention =
    formattedBodyMentioned || metadataBackedUserMention || metadataBackedRoomMention;

  return {
    mentions,
    mentionedBot: mentionedUser || mentionedRoom,
    mentionedRoom,
    hasExplicitMention,
  };
}

export function buildMatrixFormattedText(text: string): {
  body: string;
  formatted_body?: string;
  format?: "org.matrix.custom.html";
  mentions?: MatrixMentions;
} {
  const body = text.trimEnd();
  const formatted = markdownToMatrixHtml(body);
  const mentions = extractMatrixMentions(body);

  return {
    body,
    formatted_body: formatted || undefined,
    format: formatted ? "org.matrix.custom.html" : undefined,
    mentions:
      mentions.room || (mentions.user_ids?.length ?? 0) > 0 ? mentions : undefined,
  };
}

export function prefixEditedMatrixFormattedBody(formattedBody?: string): string | undefined {
  const trimmed = formattedBody?.trim();
  if (!trimmed) return undefined;

  const singleParagraph = trimmed.match(/^<p>([\s\S]*)<\/p>$/i);
  const innerBody = singleParagraph?.[1];
  if (innerBody && !innerBody.includes("<p") && !innerBody.includes("</p>")) {
    return `<p>* ${innerBody}</p>`;
  }

  return `* ${trimmed}`;
}
