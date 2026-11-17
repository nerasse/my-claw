/**
 * What a file is, decided once for every surface that shows one -- docs/file-preview.md.
 *
 * Two tables used to answer this, in two repos: the server knew ~30 extensions and mapped them to
 * image/audio/video/file (`channels/my-claw-app/files.ts`), the app had its own list and decided
 * in `viewerFor`. A `.json`, a `.py` or a `.yaml` was a file with no preview in a chat bubble and
 * a coloured editor in the file browser, on the same machine, for the same bytes.
 *
 * Three rules, in this order, because each one covers what the previous cannot:
 *
 * 1. **Magic bytes.** A screenshot pasted under a name with no extension is still a picture, and a
 *    text file named `.png` is not one. This is the only rule that reads the file, so it wins.
 * 2. **The extension.** Cheap, and right for everything ordinary. It is what the listing has
 *    without opening anything.
 * 3. **The content again, for the leftovers.** No extension, or one nobody knows: an absence of
 *    NUL bytes says text, and `text` is what can always be shown.
 *
 * The kinds are the app's vocabulary, not the MIME's: `code` and `text` are two ways to read the
 * same `text/plain`, and `csv` is not a MIME at all. `binary` is the honest end of the line -- the
 * sound of "there is nothing to show here but the download".
 */

export type FileKind =
  | "image"
  | "audio"
  | "video"
  | "pdf"
  | "markdown"
  | "html"
  | "svg"
  | "csv"
  | "json"
  | "code"
  | "text"
  | "archive"
  | "office"
  | "binary";

export interface FileKindVerdict {
  kind: FileKind;
  mimeType: string;
}

/** The app's attachment type, which stays the coarse four-value word the protocol already carries. */
export type MediaType = "image" | "audio" | "video" | "file";

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "gif", "heic", "heif", "bmp", "tiff", "tif", "avif", "ico"]);
const AUDIO_EXTENSIONS = new Set(["mp3", "m4a", "wav", "ogg", "oga", "opus", "aac", "flac", "amr", "weba", "aiff", "wma"]);
const VIDEO_EXTENSIONS = new Set(["mp4", "mov", "webm", "mkv", "m4v", "avi", "mpg", "mpeg", "3gp"]);
const MARKDOWN_EXTENSIONS = new Set(["md", "markdown", "mdown", "mdx"]);
const HTML_EXTENSIONS = new Set(["html", "htm", "xhtml"]);
const CSV_EXTENSIONS = new Set(["csv", "tsv"]);
const JSON_EXTENSIONS = new Set(["json", "jsonc", "json5", "geojson"]);
const ARCHIVE_EXTENSIONS = new Set([
  "zip", "tar", "gz", "tgz", "bz2", "tbz2", "xz", "txz", "zst", "7z", "rar", "jar", "war",
]);
const OFFICE_EXTENSIONS = new Set(["doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp", "rtf"]);
const CODE_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts", "py", "rb", "go", "rs", "java", "kt", "kts",
  "c", "h", "hpp", "hh", "hxx", "cc", "cpp", "cxx", "cs", "php", "lua", "swift", "dart", "scala", "r",
  "pl", "pm", "ex", "exs", "erl", "hs", "clj", "vue", "svelte", "astro",
  "sh", "bash", "zsh", "fish", "ksh", "ps1", "bat", "cmd",
  "sql", "plsql", "pks", "pkb", "prc", "fnc",
  "yaml", "yml", "toml", "ini", "cfg", "conf", "properties", "env", "editorconfig",
  "xml", "xsl", "xslt", "xsd", "plist", "graphql", "gql", "proto", "tf", "tfvars", "hcl",
  "diff", "patch", "dockerfile", "makefile", "cmake", "gradle", "gitignore", "gitattributes",
  "lock", "sum", "mod", "service", "rules", "nft", "lua",
]);
const TEXT_EXTENSIONS = new Set(["txt", "text", "log", "nfo", "rst", "adoc", "org", "tex", "srt", "vtt", "ics", "vcf"]);

/** Environments where a filename carries its language instead of an extension. */
const CODE_BY_FILENAME = new Set([
  "dockerfile", "makefile", "cmakelists.txt", "gemfile", "rakefile", "procfile", "justfile", "vagrantfile",
]);

const KIND_BY_EXTENSION = new Map<string, FileKind>();
for (const [kind, set] of [
  ["image", IMAGE_EXTENSIONS],
  ["audio", AUDIO_EXTENSIONS],
  ["video", VIDEO_EXTENSIONS],
  ["markdown", MARKDOWN_EXTENSIONS],
  ["html", HTML_EXTENSIONS],
  ["csv", CSV_EXTENSIONS],
  ["json", JSON_EXTENSIONS],
  ["archive", ARCHIVE_EXTENSIONS],
  ["office", OFFICE_EXTENSIONS],
  ["code", CODE_EXTENSIONS],
  ["text", TEXT_EXTENSIONS],
] as Array<[FileKind, Set<string>]>) {
  for (const extension of set) KIND_BY_EXTENSION.set(extension, kind);
}
KIND_BY_EXTENSION.set("svg", "svg");
KIND_BY_EXTENSION.set("pdf", "pdf");

const MIME_BY_EXTENSION: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif",
  heic: "image/heic", heif: "image/heif", bmp: "image/bmp", tiff: "image/tiff", tif: "image/tiff",
  avif: "image/avif", ico: "image/x-icon", svg: "image/svg+xml",
  pdf: "application/pdf",
  txt: "text/plain", log: "text/plain", nfo: "text/plain", rst: "text/plain", tex: "text/plain",
  md: "text/markdown", markdown: "text/markdown", mdown: "text/markdown", mdx: "text/markdown",
  html: "text/html", htm: "text/html", xhtml: "application/xhtml+xml",
  css: "text/css", scss: "text/x-scss", less: "text/x-less",
  json: "application/json", jsonc: "application/json", json5: "application/json", geojson: "application/geo+json",
  csv: "text/csv", tsv: "text/tab-separated-values",
  xml: "application/xml", xsl: "application/xml", xslt: "application/xml", xsd: "application/xml", plist: "application/xml",
  yaml: "text/yaml", yml: "text/yaml", toml: "text/toml", ini: "text/plain", cfg: "text/plain",
  conf: "text/plain", env: "text/plain", properties: "text/plain",
  sh: "text/x-shellscript", bash: "text/x-shellscript", zsh: "text/x-shellscript", fish: "text/x-shellscript",
  ps1: "text/plain", bat: "text/plain", cmd: "text/plain",
  sql: "text/plain", plsql: "text/plain", pks: "text/plain", pkb: "text/plain",
  mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm", mkv: "video/x-matroska",
  avi: "video/x-msvideo", mpg: "video/mpeg", mpeg: "video/mpeg", "3gp": "video/3gpp",
  mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", ogg: "audio/ogg", oga: "audio/ogg",
  opus: "audio/ogg", aac: "audio/aac", flac: "audio/flac", amr: "audio/amr", weba: "audio/webm",
  aiff: "audio/aiff", wma: "audio/x-ms-wma",
  zip: "application/zip", jar: "application/java-archive", war: "application/java-archive",
  tar: "application/x-tar", gz: "application/gzip", tgz: "application/gzip", bz2: "application/x-bzip2",
  xz: "application/x-xz", zst: "application/zstd", "7z": "application/x-7z-compressed", rar: "application/vnd.rar",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odp: "application/vnd.oasis.opendocument.presentation",
  rtf: "application/rtf",
};

export const DEFAULT_MIME = "application/octet-stream";

/** The last segment after the dot, lowercased; a bare name like `Dockerfile` is its own extension. */
export function extensionOf(filename: string): string {
  const base = (filename.split(/[/\\]/).pop() ?? "").toLowerCase();
  const dot = base.lastIndexOf(".");
  if (dot > 0 && dot < base.length - 1) return base.slice(dot + 1);
  if (dot < 0) return base;
  return base.slice(dot + 1);
}

/** The MIME an extension claims. Never sniffs: this is what a listing can answer without reading. */
export function mimeTypeForName(filename: string): string {
  return MIME_BY_EXTENSION[extensionOf(filename)] ?? DEFAULT_MIME;
}

/**
 * What the extension says, or nothing at all. Nothing is not `binary`: it means the name settles
 * nothing, and only the bytes can -- which is the one case a reader must open the file.
 */
export function kindByName(filename: string): FileKind | undefined {
  const base = (filename.split(/[/\\]/).pop() ?? "").toLowerCase();
  if (CODE_BY_FILENAME.has(base)) return "code";
  return KIND_BY_EXTENSION.get(extensionOf(filename));
}

/** The kinds a reader can show as text: anything else a name claims loses to readable bytes. */
const TEXTUAL_KINDS = new Set<FileKind>(["markdown", "html", "svg", "csv", "json", "code", "text"]);

/** The coarse word the attachment protocol carries, from the fine one. */
export function mediaTypeForKind(kind: FileKind): MediaType {
  if (kind === "image") return "image";
  if (kind === "audio") return "audio";
  if (kind === "video") return "video";
  // An SVG is a picture by nature and a `file` by contract, for now: the phone's image view draws
  // nothing for one, so announcing it as an image would put a blank frame in the media carousel
  // before the SVG renderer exists. The `kind` carries the truth; this word stays the safe one.
  return "file";
}

function at(sample: Uint8Array, start: number, length: number): string {
  let out = "";
  for (let i = start; i < start + length && i < sample.length; i++) out += String.fromCharCode(sample[i]!);
  return out;
}

function startsWithBytes(sample: Uint8Array, bytes: readonly number[]): boolean {
  if (sample.length < bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) if (sample[i] !== bytes[i]) return false;
  return true;
}

/** What the first bytes say, when they say anything at all. */
function magicVerdict(sample: Uint8Array, filename: string): FileKindVerdict | undefined {
  if (startsWithBytes(sample, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { kind: "image", mimeType: "image/png" };
  if (sample[0] === 0xff && sample[1] === 0xd8 && sample[2] === 0xff) return { kind: "image", mimeType: "image/jpeg" };
  if (at(sample, 0, 4) === "GIF8") return { kind: "image", mimeType: "image/gif" };
  if (at(sample, 0, 4) === "RIFF" && at(sample, 8, 4) === "WEBP") return { kind: "image", mimeType: "image/webp" };
  if (at(sample, 0, 2) === "BM") return { kind: "image", mimeType: "image/bmp" };
  if (at(sample, 0, 4) === "II*\u0000" || at(sample, 0, 4) === "MM\u0000*") return { kind: "image", mimeType: "image/tiff" };
  if (sample[0] === 0 && sample[1] === 0 && sample[2] === 1 && sample[3] === 0) return { kind: "image", mimeType: "image/x-icon" };

  // ISO base media: the brand at offset 8 decides between picture, sound and film.
  if (at(sample, 4, 4) === "ftyp") {
    const brand = at(sample, 8, 4).trim();
    if (brand === "avif" || brand === "avis") return { kind: "image", mimeType: "image/avif" };
    if (brand === "heic" || brand === "heix" || brand === "hevc" || brand === "mif1" || brand === "msf1") {
      return { kind: "image", mimeType: "image/heic" };
    }
    if (brand.startsWith("M4A") || brand === "mp71") return { kind: "audio", mimeType: "audio/mp4" };
    return { kind: "video", mimeType: brand === "qt" ? "video/quicktime" : "video/mp4" };
  }
  if (startsWithBytes(sample, [0x1a, 0x45, 0xdf, 0xa3])) {
    const byName = mimeTypeForName(filename);
    // EBML says "Matroska family" and nothing else: a browser records a voice note as
    // `audio/webm` under a `.weba` name, and the magic alone typed it video. A voice note that
    // arrives as a video is a voice note the transcription pass never sees, drawn as a file
    // (owner, 2026-11-17: "ça passe pas par le stt et ça envoie l'audio en pièce normal").
    if (byName === "audio/webm") return { kind: "audio", mimeType: "audio/webm" };
    return { kind: "video", mimeType: byName === "video/x-matroska" ? "video/x-matroska" : "video/webm" };
  }
  if (at(sample, 0, 4) === "RIFF" && at(sample, 8, 4) === "AVI ") return { kind: "video", mimeType: "video/x-msvideo" };

  if (at(sample, 0, 5) === "%PDF-") return { kind: "pdf", mimeType: "application/pdf" };

  if (at(sample, 0, 4) === "OggS") return { kind: "audio", mimeType: "audio/ogg" };
  if (at(sample, 0, 4) === "fLaC") return { kind: "audio", mimeType: "audio/flac" };
  if (at(sample, 0, 4) === "RIFF" && at(sample, 8, 4) === "WAVE") return { kind: "audio", mimeType: "audio/wav" };
  if (at(sample, 0, 3) === "ID3") return { kind: "audio", mimeType: "audio/mpeg" };
  if (sample[0] === 0xff && (sample[1]! & 0xe0) === 0xe0) return { kind: "audio", mimeType: "audio/mpeg" };

  if (startsWithBytes(sample, [0x50, 0x4b, 0x03, 0x04]) || startsWithBytes(sample, [0x50, 0x4b, 0x05, 0x06]) || startsWithBytes(sample, [0x50, 0x4b, 0x07, 0x08])) {
    // Office files are ZIPs; the extension is the only thing that tells them apart cheaply.
    const byName = kindByName(filename);
    if (byName === "office") return { kind: "office", mimeType: mimeTypeForName(filename) };
    return { kind: "archive", mimeType: at(sample, 0, 4) === "PK\u0005\u0006" ? DEFAULT_MIME : "application/zip" };
  }
  if (startsWithBytes(sample, [0x1f, 0x8b])) return { kind: "archive", mimeType: "application/gzip" };
  if (startsWithBytes(sample, [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])) return { kind: "archive", mimeType: "application/x-xz" };
  if (at(sample, 0, 3) === "BZh") return { kind: "archive", mimeType: "application/x-bzip2" };
  if (startsWithBytes(sample, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return { kind: "archive", mimeType: "application/x-7z-compressed" };
  if (at(sample, 0, 4) === "Rar!") return { kind: "archive", mimeType: "application/vnd.rar" };

  return undefined;
}

/**
 * The verdict for a file whose first bytes are in hand. Order matters: what the content proves,
 * then what the name claims, then what the content merely allows.
 */
export function sniffKind(sample: Uint8Array, filename: string): FileKindVerdict {
  const magic = magicVerdict(sample, filename);
  if (magic) return magic;

  if (!sample.includes(0)) {
    const head = at(sample, 0, 512).replace(/^\uFEFF/, "").trimStart().toLowerCase();
    // Markup that carries a picture or a page of its own is neither markdown nor plain text.
    if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) {
      return { kind: "svg", mimeType: "image/svg+xml" };
    }
    if (head.startsWith("<!doctype html") || head.startsWith("<html") || (head.startsWith("<?xml") && head.includes("<html"))) {
      const byName = kindByName(filename);
      if (byName === undefined || byName === "html") return { kind: "html", mimeType: "text/html" };
      if (TEXTUAL_KINDS.has(byName)) return { kind: byName, mimeType: mimeTypeForName(filename) };
      return { kind: "html", mimeType: "text/html" };
    }
    // Readable bytes outrank a name that claims a picture, a sound or an archive: a text file
    // called `notes.png` is text, and sending it to an image viewer draws nothing (the read tool
    // refuses the extension for the same reason).
    const byName = kindByName(filename);
    if (byName === "svg") return { kind: "svg", mimeType: "image/svg+xml" };
    if (byName !== undefined && TEXTUAL_KINDS.has(byName)) return { kind: byName, mimeType: mimeTypeForName(filename) };
    return { kind: "text", mimeType: "text/plain" };
  }

  // Not text, and no magic we know: the name is all that is left, and it is usually right
  // (an old `.doc`, a `.wma`). An unknown name here is honestly binary.
  const byName = kindByName(filename);
  if (byName !== undefined) return { kind: byName, mimeType: mimeTypeForName(filename) };
  return { kind: "binary", mimeType: DEFAULT_MIME };
}
