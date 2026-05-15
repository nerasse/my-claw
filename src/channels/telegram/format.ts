import MarkdownIt from "markdown-it";

const ESCAPE_MAP: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };
const FILE_REF_TLD_EXTENSIONS = new Set(["md", "go", "py", "pl", "sh", "am", "at", "be", "cc"]);
const HTML_TAG_RE = /(<\/?)([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*?>/gi;
const AUTO_LINKED_ANCHOR_RE = /<a\s+href="https?:\/\/([^"]+)"[^>]*>\1<\/a>/gi;
const FILE_EXT_PATTERN = [...FILE_REF_TLD_EXTENSIONS].join("|");
const FILE_EXT_RE = FILE_REF_TLD_EXTENSIONS.size > 0 ? new RegExp(`\\.(?:${FILE_EXT_PATTERN})$`, "i") : null;
const FILE_REF_RE = FILE_REF_TLD_EXTENSIONS.size > 0
  ? new RegExp(`(^|[^a-zA-Z0-9_\\-/])([a-zA-Z0-9_.\\-/]+\\.(?:${FILE_EXT_PATTERN}))(?=$|[^a-zA-Z0-9_\\-/])`, "gi")
  : null;

const md = new MarkdownIt({ html: false, linkify: true, breaks: false, typographer: false });
md.enable("strikethrough");
md.enable("table");

type Token = ReturnType<typeof md.parse>[number];

export function escapeHtml(text: string): string {
  return text.replace(/[&<>]/g, (ch) => ESCAPE_MAP[ch]!);
}

export function markdownToTelegramHtml(markdown: string): string {
  if (!markdown) return "";
  const tokens = md.parse(markdown, {});
  let html = renderTokens(tokens);
  html = wrapFileReferences(html);
  return html.replace(/\n{3,}/g, "\n\n").trim();
}

// ── Block-level rendering ─────────────────────────────────────

interface ListState {
  ordered: boolean;
  counter: number;
}

function renderTokens(tokens: Token[]): string {
  let result = "";
  const listStack: ListState[] = [];
  const bqStarts: number[] = [];
  let inListItem = false;
  let i = 0;

  while (i < tokens.length) {
    const t = tokens[i]!;

    switch (t.type) {
      case "paragraph_open":
        break;
      case "paragraph_close":
        if (!t.hidden) result += "\n\n";
        break;

      case "heading_open":
        result += "<b>";
        break;
      case "heading_close":
        result += "</b>\n\n";
        break;

      case "blockquote_open":
        result += "<blockquote>";
        bqStarts.push(result.length);
        break;
      case "blockquote_close": {
        const start = bqStarts.pop() ?? 0;
        let end = result.length;
        while (end > start && result[end - 1] === "\n") end--;
        if (end < result.length) result = result.slice(0, end);
        result += "</blockquote>\n\n";
        break;
      }

      case "bullet_list_open":
        listStack.push({ ordered: false, counter: 0 });
        break;
      case "bullet_list_close":
        listStack.pop();
        if (listStack.length === 0) result += "\n";
        break;

      case "ordered_list_open":
        listStack.push({ ordered: true, counter: Number(t.attrGet("start") ?? 1) - 1 });
        break;
      case "ordered_list_close":
        listStack.pop();
        if (listStack.length === 0) result += "\n";
        break;

      case "list_item_open": {
        const depth = listStack.length;
        const indent = "  ".repeat(Math.max(0, depth - 1));
        const state = listStack[listStack.length - 1]!;
        if (state.ordered) {
          state.counter++;
          result += `${indent}${state.counter}. `;
        } else {
          result += `${indent}• `;
        }
        inListItem = true;
        break;
      }
      case "list_item_close":
        inListItem = false;
        if (!result.endsWith("\n")) result += "\n";
        break;

      case "fence": {
        const lang = t.info.trim();
        const attr = lang ? ` class="language-${escapeHtml(lang)}"` : "";
        result += `<pre><code${attr}>${escapeHtml(t.content.replace(/\n$/, ""))}</code></pre>\n`;
        break;
      }
      case "code_block":
        result += `<pre><code>${escapeHtml(t.content.replace(/\n$/, ""))}</code></pre>\n`;
        break;

      case "hr":
        result += "───\n\n";
        break;

      case "table_open": {
        const table = collectTable(tokens, i);
        result += renderTableAsPre(table.data);
        i = table.endIndex;
        break;
      }

      case "inline":
        if (t.children) {
          result += renderInline(t.children, inListItem, false);
          if (inListItem) inListItem = false;
        }
        break;

      case "html_block":
        result += escapeHtml(t.content);
        break;
    }

    i++;
  }

  return result;
}

// ── Inline rendering ──────────────────────────────────────────

function renderInline(tokens: Token[], isFirstListItem: boolean, skipSpoiler: boolean): string {
  let result = "";
  let firstText = true;

  for (const t of tokens) {
    switch (t.type) {
      case "text": {
        let content = t.content;
        if (isFirstListItem && firstText) {
          content = content.replace(/^\[ \] /, "☐ ").replace(/^\[x\] /i, "☑ ");
        }
        firstText = false;
        result += skipSpoiler ? escapeHtml(content) : processTextWithSpoilers(content);
        break;
      }
      case "strong_open":
        result += "<b>";
        break;
      case "strong_close":
        result += "</b>";
        break;
      case "em_open":
        result += "<i>";
        break;
      case "em_close":
        result += "</i>";
        break;
      case "s_open":
        result += "<s>";
        break;
      case "s_close":
        result += "</s>";
        break;
      case "code_inline":
        result += `<code>${escapeHtml(t.content)}</code>`;
        break;
      case "link_open":
        result += `<a href="${escapeHtml(t.attrGet("href") ?? "")}">`;
        break;
      case "link_close":
        result += "</a>";
        break;
      case "softbreak":
      case "hardbreak":
        result += "\n";
        break;
      case "image":
        result += t.content ? escapeHtml(t.content) : "";
        break;
      case "html_inline":
        result += escapeHtml(t.content);
        break;
      default:
        if (t.content) result += escapeHtml(t.content);
        break;
    }
  }

  return result;
}

function processTextWithSpoilers(text: string): string {
  const escaped = escapeHtml(text);
  return escaped.replace(/\|\|(.+?)\|\|/gs, "<tg-spoiler>$1</tg-spoiler>");
}

// ── Table rendering ───────────────────────────────────────────

interface TableData {
  headers: string[];
  rows: string[][];
}

function collectTable(tokens: Token[], startIndex: number): { data: TableData; endIndex: number } {
  const headers: string[] = [];
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let phase: "head" | "body" | "none" = "none";

  for (let i = startIndex + 1; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.type === "table_close") return { data: { headers, rows }, endIndex: i };

    switch (t.type) {
      case "thead_open":
        phase = "head";
        break;
      case "thead_close":
        phase = "none";
        break;
      case "tbody_open":
        phase = "body";
        break;
      case "tbody_close":
        phase = "none";
        break;
      case "tr_open":
        currentRow = [];
        break;
      case "tr_close":
        if (phase === "head") headers.push(...currentRow);
        else if (phase === "body") rows.push([...currentRow]);
        break;
      case "inline":
        if (t.children) currentRow.push(renderInlinePlain(t.children));
        break;
    }
  }

  return { data: { headers, rows }, endIndex: tokens.length - 1 };
}

function renderInlinePlain(tokens: Token[]): string {
  let result = "";
  for (const t of tokens) {
    if (t.type === "text" || t.type === "code_inline") result += t.content;
    else if (t.type === "softbreak" || t.type === "hardbreak") result += " ";
    else if (t.content) result += t.content;
  }
  return result;
}

function renderTableAsPre(data: TableData): string {
  if (data.headers.length === 0) return "";

  const allRows = [data.headers, ...data.rows];
  const colWidths = data.headers.map((_, ci) => {
    let max = 0;
    for (const row of allRows) max = Math.max(max, (row[ci] ?? "").length);
    return max;
  });

  const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - s.length));
  const lines: string[] = [];

  lines.push("| " + data.headers.map((h, i) => pad(h, colWidths[i]!)).join(" | ") + " |");
  lines.push("|" + colWidths.map((w) => "-".repeat(w + 2)).join("|") + "|");
  for (const row of data.rows) {
    lines.push("| " + colWidths.map((w, i) => pad(row[i] ?? "", w)).join(" | ") + " |");
  }

  return `<pre>${escapeHtml(lines.join("\n"))}</pre>\n\n`;
}

// ── File reference wrapping ───────────────────────────────────

function wrapFileReferences(html: string): string {
  if (!FILE_EXT_RE || !FILE_REF_RE) return html;

  html = html.replace(AUTO_LINKED_ANCHOR_RE, (full, label: string) => {
    if (FILE_EXT_RE.test(label)) return `<code>${escapeHtml(label)}</code>`;
    return full;
  });

  const fileRefRe = FILE_REF_RE;

  const segments: string[] = [];
  let lastIdx = 0;
  let codeDepth = 0;
  let preDepth = 0;
  let anchorDepth = 0;

  HTML_TAG_RE.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = HTML_TAG_RE.exec(html)) !== null) {
    const text = html.slice(lastIdx, match.index);
    if (text && codeDepth === 0 && preDepth === 0 && anchorDepth === 0) {
      segments.push(text.replace(fileRefRe, "$1<code>$2</code>"));
    } else {
      segments.push(text);
    }

    segments.push(match[0]!);
    const isClosing = match[1] === "</";
    const tagName = match[2]!.toLowerCase();

    if (tagName === "code") codeDepth = Math.max(0, codeDepth + (isClosing ? -1 : 1));
    if (tagName === "pre") preDepth = Math.max(0, preDepth + (isClosing ? -1 : 1));
    if (tagName === "a") anchorDepth = Math.max(0, anchorDepth + (isClosing ? -1 : 1));

    lastIdx = match.index + match[0]!.length;
  }

  const remaining = html.slice(lastIdx);
  if (remaining && codeDepth === 0 && preDepth === 0 && anchorDepth === 0) {
    segments.push(remaining.replace(fileRefRe, "$1<code>$2</code>"));
  } else {
    segments.push(remaining);
  }

  return segments.join("");
}

// ── Utilities ─────────────────────────────────────────────────

export function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}
