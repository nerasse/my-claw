import { describe, test, expect } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMyClawAppCommandHandler, instructionsText } from "../src/channels/my-claw-app/commands.ts";
import { SessionManager } from "../src/sessions/manager.ts";
import type { ModelPicker } from "../src/channels/model-picker.ts";
import type { MyClawConfig } from "../src/core/config.ts";

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

describe("/status on the app channel", () => {
  const config = {
    llm: { defaultModel: "claude-opus-5", models: [{ id: "claude-opus-5", label: "Opus 5", limit: { context: 1_000_000 } }] },
  } as unknown as MyClawConfig;

  test("the handler answers the structured payload the page draws, not just text", async () => {
    // The adapter reads `output.status` and refuses with "status unavailable" when it is absent.
    // The adapter tests stub the handler, so only the real one wired here catches that drift.
    const handler = createMyClawAppCommandHandler({
      config,
      sessionManager: new SessionManager(),
      // The status branch never reaches the picker; the menu lives behind its own frames.
      modelPicker: {} as ModelPicker,
    });

    const output = await handler("neras", "thread-status", "status", "");

    expect(output).toBeDefined();
    expect(typeof output).toBe("object");
    const report = output as { text: string; status?: { model: { current: string } } };
    expect(report.status?.model.current).toBe("claude-opus-5");
    expect(report.text).toContain("claude-opus-5");
  });
});
