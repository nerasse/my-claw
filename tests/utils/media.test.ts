import { describe, test, expect } from "bun:test";
import { extractMediaRefs, stripMediaRefs, stripMediaRefsStreaming } from "../../src/utils/media.ts";

describe("MEDIA: refs", () => {
  test("a ref in prose is a file the agent sends", () => {
    expect(extractMediaRefs("voici le fichier\nMEDIA:/tmp/out.png").map((r) => r.path)).toEqual(["/tmp/out.png"]);
    expect(stripMediaRefs("voici le fichier\nMEDIA:/tmp/out.png")).toBe("voici le fichier");
  });

  /**
   * The system prompt teaches the format, so every message that *explains* it quotes it -- and the
   * model quotes markdown. Read as an intent, each quoted example became an attachment whose file
   * does not exist: drawn as an empty thumbnail when it looked like an image, as "<name> (deleted)"
   * otherwise, with the example cut out of the sentence around it (2026-09-14).
   */
  test("a ref inside an inline code span is prose, not a file", () => {
    const text = "l'agent ecrit `MEDIA:/tmp/out.png` dans son texte";
    expect(extractMediaRefs(text)).toEqual([]);
    expect(stripMediaRefs(text)).toBe(text);
    expect(stripMediaRefsStreaming(text)).toBe(text);
  });

  test("a ref inside a fenced block is prose, not a file", () => {
    const text = "par exemple :\n\n```\nMEDIA:/tmp/out.png\n```\n\nvoila";
    expect(extractMediaRefs(text)).toEqual([]);
    expect(stripMediaRefs(text)).toBe(text);
  });

  test("a fenced block keeps its refs when it is never closed", () => {
    const text = "```\nMEDIA:/tmp/out.png";
    expect(extractMediaRefs(text)).toEqual([]);
  });

  test("a real ref beside a quoted one still goes out", () => {
    const text = "voir `MEDIA:/tmp/a.png`\nMEDIA:/tmp/b.png";
    expect(extractMediaRefs(text).map((r) => r.path)).toEqual(["/tmp/b.png"]);
    expect(stripMediaRefs(text)).toBe("voir `MEDIA:/tmp/a.png`");
  });

  test("an unmatched backtick is prose, and does not hide the ref after it", () => {
    // Half a span is not a span: swallowing what follows would lose a real file.
    const text = "un backtick seul `\nMEDIA:/tmp/out.png";
    expect(extractMediaRefs(text).map((r) => r.path)).toEqual(["/tmp/out.png"]);
  });

  test("the streaming strip drops the ref and keeps the prose", () => {
    expect(stripMediaRefsStreaming("voici\nMEDIA:/tmp/out.png\net voila")).toBe("voici\n\net voila");
    // Held back while it could still grow into a ref, released once the next text proves it is not.
    expect(stripMediaRefsStreaming("une phrase MEDIA:/tmp/ou")).toBe("une phrase ");
  });
});
