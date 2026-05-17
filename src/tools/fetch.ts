import { type Tool, type ToolResult, str, strOpt } from "./types.ts";
import { formatError } from "../utils/errors.ts";

const BLOCKED_HOSTS = new Set(["metadata.google.internal", "metadata.goog"]);

export function isPrivateUrl(raw: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return true;
  }
  const hostname = parsed.hostname.toLowerCase();
  if (BLOCKED_HOSTS.has(hostname)) return true;
  if (hostname === "localhost" || hostname === "[::1]") return true;
  const parts = hostname.split(".");
  const first = Number(parts[0]);
  if (first === 10) return true;
  if (first === 127) return true;
  if (first === 172 && Number(parts[1]) >= 16 && Number(parts[1]) <= 31) return true;
  if (first === 192 && Number(parts[1]) === 168) return true;
  if (hostname === "169.254.169.254") return true;
  if (hostname.startsWith("0.") || hostname === "0.0.0.0") return true;
  return false;
}

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
    const url = str(args, "url");
    if (!url.trim()) {
      return { success: false, output: "url is required and cannot be empty." };
    }
    if (isPrivateUrl(url)) {
      return { success: false, output: "", error: "Blocked: URL points to a private/internal network address." };
    }
    try {
      const response = await fetch(url, {
        method: strOpt(args, "method") ?? "GET",
        body: strOpt(args, "body"),
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
