import { describe, test, expect } from "bun:test";
import { extractMediaRefs, refBasename, refsWithoutCopy, stripMediaRefs, stripMediaRefsStreaming } from "../../src/utils/media.ts";

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

/**
 * The agent bolds the ref it sends, and the prose wraps it in a sentence. A path stops at the
 * file name, not at the markdown around it: read whole, the ref named a file that never existed
 * (`fr-CV.png**`), the copy failed silently, and a reopened thread drew the picture as
 * "fr-CV.png** (deleted)" -- with the asterisks in the label (2026-09-16).
 */
describe("MEDIA: refs bounded by the prose around them", () => {
  test("the emphasis around a ref goes with it", () => {
    const text = "Voila le rendu.\n\n**MEDIA:/tmp/out.png**";
    expect(extractMediaRefs(text).map((r) => r.path)).toEqual(["/tmp/out.png"]);
    expect(stripMediaRefs(text)).toBe("Voila le rendu.");
  });

  test("an italic ref is a ref too", () => {
    const text = "rendu : *MEDIA:/tmp/out.png*";
    expect(extractMediaRefs(text).map((r) => r.path)).toEqual(["/tmp/out.png"]);
    expect(stripMediaRefs(text)).toBe("rendu :");
  });

  test("a closing punctuation never lands in the path", () => {
    expect(extractMediaRefs("(voir MEDIA:/tmp/out.png)").map((r) => r.path)).toEqual(["/tmp/out.png"]);
    expect(extractMediaRefs("c'est ici MEDIA:/tmp/out.png.").map((r) => r.path)).toEqual(["/tmp/out.png"]);
    expect(extractMediaRefs("**MEDIA:/tmp/fr-CV-1.png**.").map((r) => r.path)).toEqual(["/tmp/fr-CV-1.png"]);
  });

  test("a parenthesis the file name opened is part of the name", () => {
    expect(extractMediaRefs("MEDIA:/tmp/rapport(1).pdf").map((r) => r.path)).toEqual(["/tmp/rapport(1).pdf"]);
  });
});

describe("the name a ref resolves by", () => {
  test("a ref written with its emphasis still names the file on disk", () => {
    // The copy failed, the ref kept its asterisks, and every reload said "deleted" about a picture
    // that never left /tmp (2026-09-16).
    expect(refBasename("/tmp/qa/fr-CV.png**")).toBe("fr-CV.png");
    expect(refBasename("/tmp/qa/fr-CV.png")).toBe("fr-CV.png");
  });
});

describe("the refs a read has to put right", () => {
  test("a ref the store already holds under its name needs nothing", () => {
    // The healing case: the ref kept its asterisks, the copy is there under the real name -- the
    // history finds it, and no second copy is made (2026-09-16).
    const refs = [{ path: "/tmp/qa/fr-CV.png**" }];
    expect(refsWithoutCopy(refs, new Set(["fr-CV.png"]))).toEqual([]);
  });

  test("a ref whose name the store does not hold is the one to copy back", () => {
    expect(refsWithoutCopy([{ path: "/tmp/qa/fr-CV.png**" }], new Set())).toEqual([{ path: "/tmp/qa/fr-CV.png**" }]);
    // A ref the log already paired with an id is fetched by id: nothing to copy.
    expect(refsWithoutCopy([{ path: "/tmp/qa/fr-CV.png", id: "abc" }], new Set())).toEqual([]);
  });
});
