import type { Tool, ToolResult } from "./types.ts";

export const fetchTool: Tool = {
  name: "fetch",
  description: "Make an HTTP request",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "URL to fetch" },
      method: { type: "string", enum: ["GET", "POST", "PUT", "DELETE"], description: "HTTP method" },
      body: { type: "string", description: "Request body (for POST/PUT)" },
    },
    required: ["url"],
  },
  async execute(args): Promise<ToolResult> {
    try {
      const response = await fetch(args["url"] as string, {
        method: (args["method"] as string) ?? "GET",
        body: args["body"] as string | undefined,
      });
      const text = await response.text();
      return {
        success: response.ok,
        output: text,
        error: response.ok ? undefined : `HTTP ${response.status}`,
      };
    } catch (e) {
      return { success: false, output: "", error: String(e) };
    }
  },
};
