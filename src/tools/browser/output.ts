import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { MESSAGE_CEILING_CHARS, toolOutputDir } from "../../sessions/tool-output.ts";
import { type Tool, type ToolResult, num, str } from "../types.ts";

// Below the live message ceiling, so a part read here is never itself cut and spilled again.
const PART_CHARS = MESSAGE_CEILING_CHARS - 2_000;

/**
 * The rest of a long browser result. A result past the live ceiling reaches the model cut, with the
 * file that holds all of it; the browser agent had no tool to open that file, so everything past
 * the cut was lost to it (121 results, 2026-09-12 to 26). It reads its own run's outputs and nothing
 * else: an agent that reads untrusted pages all day gets no path to the rest of the disk.
 */
export function createBrowserReadOutputTool(): Tool {
  return {
    name: "browser_read_output",
    description:
      "Read a long result of yours in full: when a result is cut and names the file that holds all of it, read that file here, part by part (offset). Only your own results can be read.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "The file the cut result names" },
        offset: { type: "number", description: "Where to start, in characters (default 0)" },
      },
      required: ["path"],
    },
    async execute(args): Promise<ToolResult> {
      const session = typeof args["__sessionId"] === "string" ? args["__sessionId"] : "";
      const dir = resolve(toolOutputDir(session)) + sep;
      const path = resolve(str(args, "path"));
      if (!session || !path.startsWith(dir)) {
        return { success: false, output: "", error: `Only your own results can be read here: the files under ${dir}.` };
      }
      let text: string;
      try {
        text = await readFile(path, "utf8");
      } catch {
        return { success: false, output: "", error: `No such result file: ${path}.` };
      }
      const offset = Math.max(0, Math.floor(num(args, "offset", 0)));
      const part = text.slice(offset, offset + PART_CHARS);
      const next = offset + part.length;
      const rest = next < text.length ? `\n[${text.length - next} more chars: browser_read_output with offset ${next}]` : "";
      return { success: true, output: part + rest };
    },
  };
}
