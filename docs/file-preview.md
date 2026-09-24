# File preview

How a file gets shown, on every surface that shows one: a chat bubble, a conversation's session
files, the file browser, and the picker in the composer. The goal is one rule, so the same bytes
open the same way wherever the owner taps them.

## The hole this closes

Two tables answered "what is this file", in two repos. The server knew ~30 extensions and mapped
them to `image` / `audio` / `video` / `file` (`channels/my-claw-app/files.ts`); the app had its own
list and decided in `viewerFor` (`src/core/utils.ts`). The result: a `.json`, a `.py`, a `.yaml` or
a `.csv` was a nameless card with a Download button in a chat bubble, and a coloured editor in the
file browser -- same machine, same bytes. And nothing anywhere rendered a PDF, an SVG, an HTML page,
an Office document, or an image the phone does not natively decode (bmp, tiff, avif, ico).

## Decisions (owner, 2026-09-23)

- **PDF**: pdf.js inside the app's WebView. Self-contained, offline, the same machinery the
  CodeMirror editor already uses. No server dependency.
- **SVG and HTML**: a sandboxed preview with JavaScript disabled, both. `react-native-svg` renders
  the SVG natively; a strict-CSP WebView renders the HTML. The coloured source stays one tap away.
- **Office (docx, xlsx, pptx)**: the server extracts the text, the app reads it. Download keeps the
  original formatting.
- **Scope**: all of it.

## One classification

`src/utils/file-kind.ts` owns the vocabulary. A file is one of `image`, `audio`, `video`, `pdf`,
`markdown`, `html`, `svg`, `csv`, `json`, `code`, `text`, `archive`, `office`, `binary`. The coarse
`image` / `audio` / `video` / `file` the protocol already carries is derived from it
(`mediaTypeForKind`), so nothing existing breaks.

Three rules, in this order, because each covers what the previous cannot:

1. **Magic bytes.** A screenshot pasted under a name with no extension is still a picture, and a
   text file named `.png` is not one. This is the only rule that reads the file, so it wins.
2. **The extension.** Cheap, right for everything ordinary, and the only thing a listing can answer
   without opening anything (`kindByName`).
3. **The content again, for the leftovers.** No name, or one nobody knows: the absence of NUL bytes
   says text, and `text` is what can always be shown.

`sniffKind(sample, filename)` returns the verdict when the first bytes are in hand.
`kindByName(filename)` returns what the name alone says, or `undefined` -- "the name settles
nothing", which is the one case a reader must open the file.

Two facts worth writing down, because both are counter-intuitive and both are tested:

- Readable bytes outrank a name that claims a picture. A text file called `notes.png` is text.
- A ZIP is an Office file when the name says so, and an archive otherwise. The bytes cannot tell
  them apart for free; the name can.

## Where the verdict is taken

- **A write and a listing** (`save`, `saveFromPath`, `saveStream`, `listInThread`): `kindByName`, which
  costs nothing. A name nobody knows is the only case that reads the first bytes. Reading every
  write instead would reclassify a text file named `.png`, and would cost a read per attachment for
  a case that does not happen.
- The verdict rides the attachment metadata as a new additive `kind` field, never rewritten, like
  `mediaIds`, and the session file carries it too (`SessionFile.kind`).
- **Serving** (`serveMedia`): the `Content-Type` comes from the verdict, not the extension alone;
  what renders travels `inline` and answers Range, what is saved stays an `attachment`.

## What the server owes the app

- `serveMedia` sends `Content-Disposition: inline` for what the app renders, and keeps
  `attachment` for what it downloads. Today it always sends `attachment`, which a WebView or an
  `<img>` reads as a download.
- **Range** requests. `new Response(Bun.file(path))` ignores them, so nothing can seek in a PDF or
  a video, and a download cannot resume. This is a prerequisite for pdf.js.
- Conversions the app cannot do: an exotic image (bmp, tiff, avif, ico) to png, an Office document
  to text, a ZIP to its entry list. Server-side, cached by content, and only ever a fallback
  behind the app's own renderer.

## The app router

`viewerFor` becomes the single `kind -> viewer` table, and all four surfaces call it:

| kind | viewer | brick |
|---|---|---|
| image, svg | image viewer | RN `Image`, `react-native-svg` |
| markdown | document reader | `DocumentMarkdown` (exists) |
| code, text, json, html, csv | CodeMirror, read-only | the editor page (exists) |
| pdf | pdf.js | `react-native-webview` + a bundled page |
| html (preview) | sandboxed WebView, no JS | `react-native-webview`, `isDangerousHtml` |
| csv | table | `MarkdownTable` (exists) |
| archive | entry list | server |
| office | extracted text | server |
| audio, video | the existing players | exists |
| binary | download card, with the reason | exists |

The file browser already proves the CodeMirror path: it opens any text file, coloured by extension
(`LANGUAGE_BY_EXTENSION`, ~40 languages). Reusing that page in read-only mode is what closes most of
the gap, and it adds no new technology.

## Rules that keep it standing

1. **Never a blank screen.** The cascade is: detect, render, and on any failure the download card
   that says why.
2. **Content first, never the extension alone** -- but the extension carries the ordinary cases, so
   no listing pays for a read it does not need.
3. **Announced thresholds.** A text file is truncated past a size and says so; no WebView opens
   above its limit; a large image gets a thumbnail.
4. **Sandbox.** HTML and SVG render without JavaScript and without network access, and the existing
   `isDangerousHtml` stays in the path. A preview must never be a way to run something.
5. **The download card is not a failure, it is the floor.** Every kind has a way out.

## Where this stands

- **Done**:
  - The classification (`src/utils/file-kind.ts`), and the server carries `kind` on every session
    file and every attachment. `serveMedia` answers inline/attachment from it, with Range and a
    `default-src 'none'` CSP on a page or a drawing.
  - The app routes on it (`viewerFor`), and the reader is real: markdown rendered, plain text as
    it is, every code language coloured in a read-only CodeMirror, and an SVG drawn natively.
- **Next, in order**:
  1. pdf.js page (bundled like the editor page, `assets/pdfviewer`), and the sandboxed HTML
     preview. Both are WebViews, and the CSP the server already sends is their fence.
  2. Server conversions the app cannot do: an exotic image (bmp, tiff, avif, ico) to png, an
     Office document to text, a ZIP to its entry list.
  3. A CSV earns its table.
