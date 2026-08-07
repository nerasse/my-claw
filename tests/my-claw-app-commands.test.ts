import { describe, test, expect } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { instructionsText } from "../src/channels/my-claw-app/commands.ts";

describe("/instructions on the app channel", () => {
  async function dumpFile(body: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "prompt-test-"));
    const file = join(dir, "prompt-main.md");
    await writeFile(file, body, "utf-8");
    return file;
  }

  test("the prompt goes inline instead of being stringified into [object Object]", async () => {
    const file = await dumpFile("# Core directives\nbe useful");
    const text = await instructionsText({
      text: "Instructions de Orchestrator — 31 octets",
      attachments: [{ type: "file", path: file, filename: "prompt-main.md", mimeType: "text/markdown" }],
    });

    expect(text).not.toContain("[object Object]");
    expect(text).toContain("Instructions de Orchestrator");
    expect(text).toContain("# Core directives");
  });

  test("the temp file the helper wrote is removed, not leaked on every call", async () => {
    const file = await dumpFile("body");
    await instructionsText({ text: "summary", attachments: [{ type: "file", path: file }] });
    expect(existsSync(file)).toBe(false);
  });

  test("a refusal is plain text already and passes through untouched", async () => {
    expect(await instructionsText("agent inconnu : ghost")).toBe("agent inconnu : ghost");
  });

  test("a message without an attachment keeps its text", async () => {
    expect(await instructionsText({ text: "summary only" })).toBe("summary only");
  });

  test("an unreadable dump still answers the summary", async () => {
    // The file is gone: losing the dump must not turn the command into a dead button.
    const text = await instructionsText({
      text: "summary",
      attachments: [{ type: "file", path: join(tmpdir(), "prompt-missing", "prompt-main.md") }],
    });
    expect(text).toBe("summary");
  });

  test("the inlined body is the file's, byte for byte", async () => {
    const body = "# Available tools\n- read: read tool\n\n```\nfenced block\n```\n";
    const file = await dumpFile(body);
    const text = await instructionsText({ text: "summary", attachments: [{ type: "file", path: file }] });
    expect(text.endsWith(body)).toBe(true);
  });
});
