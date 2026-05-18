import { lookup } from "node:dns/promises";
import { type Tool, type ToolResult, str, strOpt } from "./types.ts";
import { formatError } from "../utils/errors.ts";

const BLOCKED_HOSTS = new Set(["metadata.google.internal", "metadata.goog"]);

export function isPrivateIp(ip: string): boolean {
  if (ip.includes(":")) {
    const lower = ip.toLowerCase().replace(/^\[|\]$/g, "");
    if (lower === "::1" || lower === "::") return true;
    if (lower.startsWith("fe80")) return true;
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
    if (lower.startsWith("::ffff:")) {
      const mapped = lower.slice(7);
      if (mapped.includes(".")) return isPrivateIp(mapped);
      // Hex form: ::ffff:7f00:1 -> 127.0.0.1
      const hexParts = mapped.split(":");
      if (hexParts.length === 2) {
        const hi = parseInt(hexParts[0]!, 16);
        const lo = parseInt(hexParts[1]!, 16);
        if (!isNaN(hi) && !isNaN(lo)) {
          const v4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
          return isPrivateIp(v4);
        }
      }
    }
    return false;
  }
  const parts = ip.split(".");
  if (parts.length !== 4) return false;
  const first = Number(parts[0]);
  if (first === 10) return true;
  if (first === 127) return true;
  if (first === 172 && Number(parts[1]) >= 16 && Number(parts[1]) <= 31) return true;
  if (first === 192 && Number(parts[1]) === 168) return true;
  if (ip.startsWith("169.254.")) return true;
  if (ip.startsWith("0.") || ip === "0.0.0.0") return true;
  return false;
}

export function isPrivateUrl(raw: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return true;
  }
  const hostname = parsed.hostname.toLowerCase();
  if (BLOCKED_HOSTS.has(hostname)) return true;
  if (hostname === "localhost") return true;
  if (isPrivateIp(hostname)) return true;
  return false;
}

export async function resolveAndCheckUrl(raw: string): Promise<boolean> {
  if (isPrivateUrl(raw)) return true;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return true;
  }
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  try {
    const results = await lookup(hostname, { all: true });
    for (const { address } of results) {
      if (isPrivateIp(address)) return true;
    }
  } catch {
    // DNS failure will also fail the fetch; allow through
  }
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
    if (await resolveAndCheckUrl(url)) {
      return { success: false, output: "", error: "Blocked: URL points to a private/internal network address." };
    }
    try {
      const method = strOpt(args, "method") ?? "GET";
      const body = strOpt(args, "body");
      const MAX_REDIRECTS = 5;
      let currentUrl = url;

      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 30_000);
        const response = await fetch(currentUrl, {
          method: hop === 0 ? method : "GET",
          body: hop === 0 ? body : undefined,
          redirect: "manual",
          signal: controller.signal,
        });
        clearTimeout(timer);

        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          if (!location) break;
          const resolved = new URL(location, currentUrl).href;
          if (await resolveAndCheckUrl(resolved)) {
            return { success: false, output: "", error: "Blocked: redirect target points to a private/internal network address." };
          }
          currentUrl = resolved;
          continue;
        }

        const text = await response.text();
        if (response.ok) {
          return { success: true, output: text };
        }
        return {
          success: false,
          output: text,
          error: `HTTP ${response.status} from ${currentUrl}. Check the URL, method, and authentication.`,
        };
      }

      return { success: false, output: "", error: "Too many redirects." };
    } catch (e) {
      return { success: false, output: "", error: formatError(`Failed to fetch "${url}"`, e) };
    }
  },
};
