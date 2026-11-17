/**
 * What a file is, from its bytes first and its name second -- docs/file-preview.md.
 *
 * The cases that matter are the ones where the two disagree: a screenshot with no extension, a
 * text file named `.png`, a ZIP that is really a spreadsheet. Both repos had a table of
 * extensions and no answer for any of them.
 */
import { test, expect, describe } from "bun:test";
import { extensionOf, kindByName, mediaTypeForKind, mimeTypeForName, sniffKind } from "../../src/utils/file-kind.ts";

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);
const ascii = (text: string): Uint8Array => new TextEncoder().encode(text);

const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d);
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10);
const GIF = ascii("GIF89a......");
const WEBP = ascii("RIFF????WEBP....");
const WAV = ascii("RIFF????WAVE....");
const MP3 = ascii("ID3\u0003\u0000\u0000\u0000");
const OGG = ascii("OggS....");
const FLAC = ascii("fLaC....");
const WEBM = bytes(0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00);
const PDF = ascii("%PDF-1.7\n%....");
const ZIP = bytes(0x50, 0x4b, 0x03, 0x04, 0x14, 0x00);
const GZIP = bytes(0x1f, 0x8b, 0x08, 0x00);
const ftyp = (brand: string): Uint8Array => ascii(`\u0000\u0000\u0000\u0018ftyp${brand}....`);

describe("sniffKind, what the bytes prove", () => {
  test("a screenshot with no extension is still a picture", () => {
    expect(sniffKind(PNG, "Screenshot 2026-09-23 at 20.51")).toEqual({ kind: "image", mimeType: "image/png" });
    expect(sniffKind(JPEG, "photo")).toEqual({ kind: "image", mimeType: "image/jpeg" });
    expect(sniffKind(GIF, "anim")).toEqual({ kind: "image", mimeType: "image/gif" });
    expect(sniffKind(WEBP, "shot.webp")).toEqual({ kind: "image", mimeType: "image/webp" });
  });

  test("an image brand decides what the container holds", () => {
    expect(sniffKind(ftyp("heic"), "IMG_1234")).toEqual({ kind: "image", mimeType: "image/heic" });
    expect(sniffKind(ftyp("avif"), "shot.avif")).toEqual({ kind: "image", mimeType: "image/avif" });
    expect(sniffKind(ftyp("M4A "), "voice")).toEqual({ kind: "audio", mimeType: "audio/mp4" });
    expect(sniffKind(ftyp("isom"), "clip")).toEqual({ kind: "video", mimeType: "video/mp4" });
  });

  test("audio and film formats carry their own signature", () => {
    expect(sniffKind(MP3, "voice")).toEqual({ kind: "audio", mimeType: "audio/mpeg" });
    expect(sniffKind(OGG, "voice.ogg")).toEqual({ kind: "audio", mimeType: "audio/ogg" });
    expect(sniffKind(FLAC, "song")).toEqual({ kind: "audio", mimeType: "audio/flac" });
    expect(sniffKind(WAV, "recording")).toEqual({ kind: "audio", mimeType: "audio/wav" });
    expect(sniffKind(WEBM, "screen.webm")).toEqual({ kind: "video", mimeType: "video/webm" });
    // EBML is the Matroska family, and a browser records a voice note as audio/webm under `.weba`.
    // Typed video, that recording never reached the transcription pass and drew as a file.
    expect(sniffKind(WEBM, "voice-2026-11-17T12-30-00.weba")).toEqual({ kind: "audio", mimeType: "audio/webm" });
  });

  test("a PDF, a ZIP and a tarball are named by their bytes too", () => {
    expect(sniffKind(PDF, "report.pdf")).toEqual({ kind: "pdf", mimeType: "application/pdf" });
    expect(sniffKind(PDF, "misleading.txt")).toEqual({ kind: "pdf", mimeType: "application/pdf" });
    expect(sniffKind(ZIP, "bundle.zip")).toEqual({ kind: "archive", mimeType: "application/zip" });
    expect(sniffKind(GZIP, "logs")).toEqual({ kind: "archive", mimeType: "application/gzip" });
  });

  test("a ZIP is an Office file when the name says so, and an archive otherwise", () => {
    expect(sniffKind(ZIP, "budget.xlsx")).toEqual({
      kind: "office",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    expect(sniffKind(ZIP, "release.docx")).toEqual({
      kind: "office",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    expect(sniffKind(ZIP, "sources.tar")).toEqual({ kind: "archive", mimeType: "application/zip" });
  });
});

describe("sniffKind, what the readable bytes say", () => {
  test("a text file named .png is text, never a picture", () => {
    expect(sniffKind(ascii("just some notes\n"), "notes.png")).toEqual({ kind: "text", mimeType: "text/plain" });
    expect(sniffKind(ascii("{\"a\":1}"), "payload.zip")).toEqual({ kind: "text", mimeType: "text/plain" });
  });

  test("markup that carries a picture or a page is read as such, extension or not", () => {
    expect(sniffKind(ascii('<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>'), "icon")).toEqual({
      kind: "svg",
      mimeType: "image/svg+xml",
    });
    expect(sniffKind(ascii('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>'), "logo.xml")).toEqual({
      kind: "svg",
      mimeType: "image/svg+xml",
    });
    expect(sniffKind(ascii("<!doctype html><html><body>hi</body></html>"), "page")).toEqual({
      kind: "html",
      mimeType: "text/html",
    });
  });

  test("an unknown name over readable bytes is text, which is always showable", () => {
    expect(sniffKind(ascii("Meeting notes\nline two\n"), "notes")).toEqual({ kind: "text", mimeType: "text/plain" });
    expect(sniffKind(ascii("hello"), "data.bin")).toEqual({ kind: "text", mimeType: "text/plain" });
  });

  test("the name still picks the dialect when it is a readable one", () => {
    expect(sniffKind(ascii("# Title\n\nbody\n"), "readme.md")).toEqual({ kind: "markdown", mimeType: "text/markdown" });
    expect(sniffKind(ascii("a,b,c\n1,2,3\n"), "rows.csv").kind).toBe("csv");
    expect(sniffKind(ascii('{"a":1}'), "conf.json").kind).toBe("json");
    expect(sniffKind(ascii("import os\n\nprint(os.name)\n"), "main.py").kind).toBe("code");
    expect(sniffKind(ascii("FROM node:22\nRUN bun install\n"), "Dockerfile").kind).toBe("code");
    expect(sniffKind(ascii("server { listen 80; }\n"), "site.conf").kind).toBe("code");
  });

  test("a NUL byte makes it binary, whatever the name claims", () => {
    expect(sniffKind(bytes(0x00, 0x01, 0x02, 0x03), "data.bin")).toEqual({ kind: "binary", mimeType: "application/octet-stream" });
    expect(sniffKind(bytes(0x00, 0x01, 0x02), "mystery")).toEqual({ kind: "binary", mimeType: "application/octet-stream" });
  });

  test("a binary with a name we know keeps that name's kind", () => {
    // An old `.doc` and a `.wma` have no signature we read: the extension is all there is.
    expect(sniffKind(bytes(0xd0, 0x00, 0x00, 0x00), "letter.doc").kind).toBe("office");
    expect(sniffKind(bytes(0x30, 0x00, 0x00, 0x00), "song.wma").kind).toBe("audio");
  });
});

describe("the name alone, for a listing that reads nothing", () => {
  test("kindByName answers the ordinary cases and stays silent on the rest", () => {
    expect(kindByName("main.ts")).toBe("code");
    expect(kindByName("Makefile")).toBe("code");
    expect(kindByName("README.md")).toBe("markdown");
    expect(kindByName("photo.HEIC")).toBe("image");
    expect(kindByName("notes.txt")).toBe("text");
    expect(kindByName("sheet.xlsx")).toBe("office");
    expect(kindByName("archive.tar.gz")).toBe("archive");
    expect(kindByName("report.pdf")).toBe("pdf");
    expect(kindByName("icon.svg")).toBe("svg");
    expect(kindByName("weird.qqq")).toBeUndefined();
    expect(kindByName("noextension")).toBeUndefined();
  });

  test("the extension is the last segment, lowercased, and a bare name is its own", () => {
    expect(extensionOf("a/b/c.TXT")).toBe("txt");
    expect(extensionOf("archive.tar.gz")).toBe("gz");
    expect(extensionOf("Dockerfile")).toBe("dockerfile");
    expect(extensionOf("/home/neras/.env")).toBe("env");
    // A trailing dot names no extension at all, so the kind stays unknown.
    expect(extensionOf("trailing.")).toBe("");
    expect(kindByName("trailing.")).toBeUndefined();
  });

  test("a MIME comes from the extension, or nothing does", () => {
    expect(mimeTypeForName("clip.mp4")).toBe("video/mp4");
    expect(mimeTypeForName("drawing.svg")).toBe("image/svg+xml");
    expect(mimeTypeForName("unknown.zzz")).toBe("application/octet-stream");
  });

  test("an SVG stays a `file` to the protocol until something can draw it", () => {
    expect(mediaTypeForKind("image")).toBe("image");
    expect(mediaTypeForKind("audio")).toBe("audio");
    expect(mediaTypeForKind("video")).toBe("video");
    for (const kind of ["svg", "pdf", "markdown", "html", "csv", "json", "code", "text", "archive", "office", "binary"] as const) {
      expect(mediaTypeForKind(kind)).toBe("file");
    }
  });
});
