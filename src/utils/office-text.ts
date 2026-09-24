/**
 * The words out of an Office document, without an Office library.
 *
 * A `.docx`, `.xlsx` and `.pptx` are ZIPs of XML, so the text is a few parts read out of the
 * archive and a pass over their tags -- `utils/archive.ts` for the first half, the small walker
 * below for the second. That is why the owner's "texte extrait côté serveur" needs no
 * dependency, and why this only ever produces text: the layout is not here, and Download keeps
 * the document itself (docs/file-preview.md).
 *
 * What each format keeps its text in:
 *
 * - `.docx`: `word/document.xml`, runs in `<w:t>` inside `<w:p>`.
 * - `.pptx`: `ppt/slides/slideN.xml`, runs in `<a:t>` inside `<a:p>`.
 * - `.xlsx`: shared strings in `xl/sharedStrings.xml`, and cells in `xl/worksheets/sheetN.xml`
 *   that index them -- rendered tab-separated, one line per row.
 * - OpenDocument (`.odt`, `.ods`, `.odp`): `content.xml`.
 *
 * The legacy binary formats (`.doc`, `.xls`, `.ppt`) are not ZIPs and are not read: they answer
 * nothing, and the reader falls back to the download card.
 */

import { findZipEntry, listZipEntries, readZipEntry, type ZipEntry } from "./archive.ts";

/** Long documents are cut here: a phone cannot scroll a novel, and nobody reads one in a bubble. */
const MAX_TEXT_CHARS = 200_000;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (whole, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? whole);
}

/**
 * The text of a document part, one line per paragraph.
 *
 * A tag walker rather than a stack of regexes: the runs matter, their order matters, and a
 * paragraph break has to land between them. `<w:t>`, `<a:t>` and OpenDocument's own text tags all
 * reduce to "this is inside a run", "this closes a paragraph", "this is a tab".
 */
function xmlToText(xml: string): string {
  let out = "";
  // Depth, not a flag: Word and PowerPoint put the text in a run (`<w:t>`, `<a:t>`) while
  // OpenDocument puts it straight in the paragraph (`<text:p>`), and both have to be read.
  let depth = 0;
  const token = /<(\/?)([A-Za-z0-9_:]+)([^>]*?)(\/?)>|([^<]+)/g;
  let match: RegExpExecArray | null;
  while ((match = token.exec(xml)) !== null) {
    if (match[5] !== undefined) {
      if (depth > 0) out += decodeEntities(match[5]);
      continue;
    }
    const closing = match[1] === "/";
    const rawName = match[2]!;
    const selfClosing = match[4] === "/";
    const local = rawName.slice(rawName.indexOf(":") + 1).toLowerCase();
    const paragraph = local === "p" || local === "h" || local === "li";
    if (local === "t" || local === "span" || paragraph) {
      if (closing) {
        depth = Math.max(0, depth - 1);
        if (paragraph) out += "\n";
      } else if (!selfClosing) {
        depth += 1;
      }
    } else if (local === "tab") {
      out += "\t";
    } else if (local === "br") {
      out += "\n";
    }
  }
  return out;
}

/** Trims the trailing blanks a tagged document leaves behind, and caps the whole thing. */
function tidy(text: string): string {
  const lines = text
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (lines.length <= MAX_TEXT_CHARS) return lines;
  return `${lines.slice(0, MAX_TEXT_CHARS)}\n\n[cut at ${MAX_TEXT_CHARS} characters]`;
}

async function partText(path: string, entry: ZipEntry | undefined): Promise<string> {
  if (!entry) return "";
  const bytes = await readZipEntry(path, entry);
  if (!bytes) return "";
  return xmlToText(bytes.toString("utf8"));
}

/** A spreadsheet as tab-separated rows, resolving the cells that index the shared strings. */
async function spreadsheetText(path: string, entries: readonly ZipEntry[]): Promise<string> {
  const sharedEntry = findZipEntry(entries, "xl/sharedStrings.xml");
  const sharedBytes = sharedEntry ? await readZipEntry(path, sharedEntry) : null;
  // One entry per `<si>`: the cells index this list, so a single blob of text would shift every
  // value by one.
  const shared = sharedBytes
    ? (sharedBytes.toString("utf8").match(/<si[\s\S]*?<\/si>/g) ?? []).map((si) =>
        xmlToText(si).replace(/\s+/g, " ").trim(),
      )
    : [];

  const sheets = entries
    .filter((entry) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

  const blocks: string[] = [];
  for (const sheet of sheets) {
    const bytes = await readZipEntry(path, sheet);
    if (!bytes) continue;
    const xml = bytes.toString("utf8");
    const rows: string[] = [];
    for (const row of xml.match(/<row[\s\S]*?<\/row>/g) ?? []) {
      const cells: string[] = [];
      for (const cell of row.match(/<c[\s\S]*?(?:<\/c>|\/>)/g) ?? []) {
        const sharedIndex = /t="s"[\s\S]*?<v>(\d+)<\/v>/.exec(cell);
        if (sharedIndex) {
          cells.push(shared[Number(sharedIndex[1])] ?? "");
          continue;
        }
        const inline = /<t[^>]*>([\s\S]*?)<\/t>/.exec(cell);
        if (inline) {
          cells.push(decodeEntities(inline[1]!).replace(/\n+/g, " "));
          continue;
        }
        const value = /<v>([\s\S]*?)<\/v>/.exec(cell);
        cells.push(value ? decodeEntities(value[1]!) : "");
      }
      if (cells.some((cell) => cell !== "")) rows.push(cells.join("\t"));
    }
    if (rows.length > 0) blocks.push(rows.join("\n"));
  }
  return blocks.join("\n\n");
}

/**
 * The document's text, or nothing when the format is not one this reads. `null` is the signal to
 * fall back to the download card; an empty string would read as an empty document.
 */
export async function extractOfficeText(path: string): Promise<string | null> {
  const entries = await listZipEntries(path);
  if (entries.length === 0) return null;

  const word = findZipEntry(entries, "word/document.xml");
  if (word) {
    const text = tidy(await partText(path, word));
    return text === "" ? null : text;
  }

  const slides = entries
    .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/i.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  if (slides.length > 0) {
    const parts: string[] = [];
    for (const [index, slide] of slides.entries()) {
      const text = tidy(await partText(path, slide));
      if (text !== "") parts.push(`Slide ${index + 1}\n${text}`);
    }
    const joined = tidy(parts.join("\n\n"));
    return joined === "" ? null : joined;
  }

  if (findZipEntry(entries, "xl/workbook.xml")) {
    const text = tidy(await spreadsheetText(path, entries));
    return text === "" ? null : text;
  }

  const content = findZipEntry(entries, "content.xml");
  if (content) {
    const text = tidy(await partText(path, content));
    return text === "" ? null : text;
  }

  return null;
}
