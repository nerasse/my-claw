import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { toolOutputPath } from "../../src/sessions/tool-output.ts";
import { createBrowserReadOutputTool } from "../../src/tools/browser/output.ts";
import { MESSAGE_CEILING_CHARS } from "../../src/sessions/tool-output.ts";

async function spilled(session: string, callId: string, text: string): Promise<string> {
  const path = toolOutputPath(session, callId);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
  return path;
}

/**
 * A browser result past the live ceiling reaches the agent cut, naming the file with all of it, and
 * the browser agent had nothing to open that file with (121 results lost past the cut, 2026-09-12
 * to 26). It reads its own run's outputs, all the way, and nothing else on the disk.
 */
describe("browser_read_output", () => {
  const tool = createBrowserReadOutputTool();

  test("a long result is read to its end, part by part, each part below the live ceiling", async () => {
    const text = Array.from({ length: 5000 }, (_, i) => `row ${i} ${"x".repeat(40)}`).join("\n");
    const path = await spilled("subagent/run-a", "call-1", text);
    let read = "";
    let offset = 0;
    for (let parts = 0; parts < 20; parts++) {
      const result = await tool.execute({ __sessionId: "subagent/run-a", path, offset });
      expect(result.success).toBe(true);
      expect(result.output.length).toBeLessThan(MESSAGE_CEILING_CHARS);
      const more = result.output.match(/\n\[\d+ more chars: browser_read_output with offset (\d+)\]$/);
      read += more ? result.output.slice(0, more.index) : result.output;
      if (!more) break;
      offset = Number(more[1]);
    }
    expect(read).toBe(text);
  });

  test("another run's output, or any other file, is refused", async () => {
    const other = await spilled("subagent/run-b", "call-1", "not yours");
    const refused = await tool.execute({ __sessionId: "subagent/run-a", path: other });
    expect(refused.success).toBe(false);
    expect(refused.error).toContain("Only your own results");

    const env = await tool.execute({ __sessionId: "subagent/run-a", path: "/home/someone/.my-claw/.env" });
    expect(env.success).toBe(false);

    const own = toolOutputPath("subagent/run-a", "x");
    const escape = await tool.execute({ __sessionId: "subagent/run-a", path: join(dirname(own), "..", "..", "run-b", "tool-output", "call-1") });
    expect(escape.success).toBe(false);
  });

  test("a missing result file is said to be missing", async () => {
    const result = await tool.execute({ __sessionId: "subagent/run-a", path: toolOutputPath("subagent/run-a", "never") });
    expect(result.success).toBe(false);
    expect(result.error).toContain("No such result file");
  });
});
