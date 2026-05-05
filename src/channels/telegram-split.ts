export const CHUNK_LIMIT = 4000;

const HTML_TAG_RE = /(<\/?)([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*?>/g;
const SELF_CLOSING = new Set(["br"]);

interface TagEntry {
  name: string;
  openTag: string;
  closeTag: string;
}

function closeSuffix(stack: TagEntry[]): string {
  let s = "";
  for (let i = stack.length - 1; i >= 0; i--) {
    s += stack[i]!.closeTag;
  }
  return s;
}

function openPrefix(stack: TagEntry[]): string {
  let s = "";
  for (const tag of stack) {
    s += tag.openTag;
  }
  return s;
}

function findSafeSplitIndex(text: string, maxLen: number): number {
  if (maxLen >= text.length) return text.length;
  let idx = maxLen;
  for (let i = idx - 1; i >= Math.max(0, idx - 10); i--) {
    if (text[i] === "&") {
      const rest = text.slice(i, Math.min(text.length, i + 12));
      const entityMatch = rest.match(/^&(?:#[0-9]+|#x[0-9a-fA-F]+|[a-zA-Z]+);/);
      if (entityMatch) {
        const entityEnd = i + entityMatch[0]!.length;
        if (entityEnd > idx) return i;
      }
      break;
    }
  }
  return idx;
}

export function splitHtmlChunks(html: string, limit = CHUNK_LIMIT): string[] {
  if (html.length <= limit) return [html];

  const chunks: string[] = [];
  const stack: TagEntry[] = [];
  let current = "";
  let lastIndex = 0;

  function appendRaw(s: string) {
    current += s;
  }

  function flush() {
    current += closeSuffix(stack);
    if (current) chunks.push(current);
    current = openPrefix(stack);
  }

  function appendText(text: string) {
    let pos = 0;
    while (pos < text.length) {
      const closeLen = closeSuffix(stack).length;
      const available = limit - current.length - closeLen;

      if (available <= 0) {
        flush();
        continue;
      }

      const remaining = text.length - pos;
      if (remaining <= available) {
        current += text.slice(pos);
        pos = text.length;
      } else {
        const splitAt = findSafeSplitIndex(text.slice(pos), available);
        if (splitAt === 0) {
          flush();
          continue;
        }
        current += text.slice(pos, pos + splitAt);
        pos += splitAt;
        flush();
      }
    }
  }

  HTML_TAG_RE.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = HTML_TAG_RE.exec(html)) !== null) {
    const textBefore = html.slice(lastIndex, match.index);
    if (textBefore) appendText(textBefore);

    const fullTag = match[0]!;
    const isClosing = match[1] === "</";
    const tagName = match[2]!.toLowerCase();

    if (SELF_CLOSING.has(tagName)) {
      appendRaw(fullTag);
    } else if (isClosing) {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i]!.name === tagName) {
          stack.splice(i, 1);
          break;
        }
      }
      appendRaw(fullTag);
    } else {
      const closeTag = `</${tagName}>`;
      const needed = fullTag.length + closeTag.length;
      const available = limit - current.length - closeSuffix(stack).length;

      if (needed > available && current.length > openPrefix(stack).length) {
        flush();
      }

      stack.push({ name: tagName, openTag: fullTag, closeTag });
      appendRaw(fullTag);
    }

    lastIndex = match.index + fullTag.length;
  }

  const remaining = html.slice(lastIndex);
  if (remaining) appendText(remaining);

  if (current.length > 0) {
    current += closeSuffix(stack);
    if (current) chunks.push(current);
  }

  return chunks.length > 0 ? chunks : [html];
}

export function splitPlainText(text: string, limit = CHUNK_LIMIT): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let pos = 0;

  while (pos < text.length) {
    if (text.length - pos <= limit) {
      chunks.push(text.slice(pos));
      break;
    }

    let splitAt = text.lastIndexOf("\n", pos + limit);
    if (splitAt <= pos) {
      splitAt = text.lastIndexOf(" ", pos + limit);
    }
    if (splitAt <= pos) {
      splitAt = pos + limit;
    }

    chunks.push(text.slice(pos, splitAt));
    pos = splitAt;
    if (text[pos] === "\n" || text[pos] === " ") pos++;
  }

  return chunks;
}

export function alignPlainTextChunks(plainText: string, htmlChunkCount: number, limit = CHUNK_LIMIT): string[] {
  if (htmlChunkCount <= 1) return [plainText];

  const chunks: string[] = [];
  let remaining = plainText;

  for (let i = 0; i < htmlChunkCount; i++) {
    if (i === htmlChunkCount - 1) {
      chunks.push(remaining);
      break;
    }

    const remainingChunks = htmlChunkCount - i;
    const targetLen = Math.min(limit, Math.ceil(remaining.length / remainingChunks));

    let splitAt = remaining.lastIndexOf("\n", targetLen);
    if (splitAt <= targetLen * 0.3) {
      splitAt = remaining.lastIndexOf(" ", targetLen);
    }
    if (splitAt <= 0) {
      splitAt = targetLen;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
    if (remaining.startsWith("\n") || remaining.startsWith(" ")) {
      remaining = remaining.slice(1);
    }
  }

  return chunks;
}
