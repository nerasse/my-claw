import type { Tool, ToolResult } from "./types.ts";
import { formatError } from "../utils/errors.ts";

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
    const url = args["url"] as string;
    if (!url || !url.trim()) {
      return { success: false, output: "url is required and cannot be empty." };
    }
    try {
      const response = await fetch(url, {
        method: (args["method"] as string) ?? "GET",
        body: args["body"] as string | undefined,
      });
      const text = await response.text();
      if (response.ok) {
        return { success: true, output: text };
      }
      return {
        success: false,
        output: text,
        error: `HTTP ${response.status} from ${url}. Check the URL, method, and authentication.`,
      };
    } catch (e) {
      return { success: false, output: "", error: formatError(`Failed to fetch "${url}"`, e) };
    }
  },
};
