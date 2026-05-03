import type { Tool, ToolResult } from "./types.ts";

export const grepTool: Tool = {
  name: "grep",
  description: "Search for a pattern in files",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Search pattern (regex)" },
      path: { type: "string", description: "Directory or file to search in" },
      recursive: { type: "boolean", description: "Search recursively" },
    },
    required: ["pattern", "path"],
  },
  async execute(args): Promise<ToolResult> {
    try {
      const flags = args["recursive"] !== false ? "-rn" : "-n";
      const proc = Bun.spawn(
        ["grep", flags, args["pattern"] as string, args["path"] as string],
        { stdout: "pipe", stderr: "pipe" },
      );
      const stdout = await new Response(proc.stdout).text();
      await proc.exited;
      return { success: true, output: stdout || "No matches found" };
    } catch (e) {
      return { success: false, output: "", error: String(e) };
    }
  },
};
