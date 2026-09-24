/**
 * The words out of an Office document -- the owner's "texte extrait côté serveur", with no
 * Office library: a `.docx`, `.xlsx` and `.pptx` are ZIPs of XML (docs/file-preview.md).
 */
import { test, expect, describe } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractOfficeText } from "../../src/utils/office-text.ts";
import { part, writeZipFile } from "../helpers/zip.ts";

describe("a document's text, out of its own parts", () => {
  test("a .docx reads its runs, one line per paragraph, and decodes entities", async () => {
    const path = await writeZipFile([
      part("word/document.xml", [
        "<w:document><w:body>",
        "<w:p><w:r><w:t>Bonjour</w:t></w:r><w:r><w:t xml:space=\"preserve\"> le monde</w:t></w:r></w:p>",
        "<w:p><w:r><w:t>R&amp;D budget</w:t></w:r></w:p>",
        "</w:body></w:document>",
      ].join("")),
      part("[Content_Types].xml", "<Types/>"),
    ]);
    expect(await extractOfficeText(path)).toBe("Bonjour le monde\nR&D budget");
  });

  test("a .pptx numbers its slides and keeps them apart", async () => {
    const path = await writeZipFile([
      part("ppt/slides/slide1.xml", "<p:sld><a:p><a:r><a:t>First</a:t></a:r></a:p></p:sld>"),
      part("ppt/slides/slide2.xml", "<p:sld><a:p><a:r><a:t>Second</a:t></a:r></a:p></p:sld>"),
    ]);
    expect(await extractOfficeText(path)).toBe("Slide 1\nFirst\n\nSlide 2\nSecond");
  });

  test("a .xlsx resolves the cells that index its shared strings", async () => {
    const path = await writeZipFile([
      part("xl/workbook.xml", "<workbook/>"),
      part("xl/sharedStrings.xml", "<sst><si><t>Name</t></si><si><t>Total</t></si><si><t>Ada</t></si></sst>"),
      part(
        "xl/worksheets/sheet1.xml",
        '<worksheet><sheetData><row><c t="s"><v>0</v></c><c t="s"><v>1</v></c></row>' +
          '<row><c t="s"><v>2</v></c><c><v>42</v></c></row></sheetData></worksheet>',
      ),
    ]);
    const text = await extractOfficeText(path);
    expect(text).toContain("Name\tTotal");
    expect(text).toContain("Ada\t42");
  });

  test("an OpenDocument keeps the text that sits straight in the paragraph", async () => {
    const path = await writeZipFile([
      part(
        "content.xml",
        '<office:document-content><office:body><text:p>Salut</text:p><text:p>Deuxième ligne</text:p></office:body></office:document-content>',
      ),
    ]);
    expect(await extractOfficeText(path)).toBe("Salut\nDeuxième ligne");
  });
});

describe("what this reader will not invent", () => {
  test("a legacy binary document is not a ZIP at all, so it answers nothing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "doc-"));
    const path = join(dir, "letter.doc");
    await writeFile(path, Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0x00, 0x01]));
    expect(await extractOfficeText(path)).toBeNull();
  });

  test("a document with no text answers nothing, rather than an empty page", async () => {
    const path = await writeZipFile([part("word/document.xml", "<w:document><w:body></w:body></w:document>")]);
    expect(await extractOfficeText(path)).toBeNull();
  });

  test("a ZIP with no part we know is not a document", async () => {
    const path = await writeZipFile([part("photos/holiday.jpg", "not xml at all")]);
    expect(await extractOfficeText(path)).toBeNull();
  });

  test("a file that is not an archive at all answers nothing", async () => {
    const path = await writeZipFile([part("readme.txt", "hello")]);
    expect(await extractOfficeText(path)).toBeNull();
  });
});
