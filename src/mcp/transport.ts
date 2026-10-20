import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpServerConfig } from "../core/config.ts";

/**
 * What both MCP clients share: the server-side manager and the one a node runs on someone else's
 * machine. The transport handshake, the name space and the connect deadline are the same or the
 * two disagree on what an MCP server is.
 */

/** Tools are namespaced so an external server cannot shadow a built-in: `mcp__<server>__<tool>`. */
export function mcpToolName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`;
}

/** Rejects rather than hanging: an await with no deadline is a boot with no deadline. */
export async function withDeadline<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function buildTransport(config: McpServerConfig): Transport {
  if (config.transport === "stdio") {
    if (!config.command) throw new Error("stdio MCP server requires 'command'");
    return new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      env: { ...getDefaultEnvironment(), ...(config.env ?? {}) },
      stderr: "ignore",
    });
  }
  if (!config.url) throw new Error(`${config.transport} MCP server requires 'url'`);
  const url = new URL(config.url);
  const opts = config.headers ? { requestInit: { headers: config.headers } } : undefined;
  return config.transport === "sse"
    ? new SSEClientTransport(url, opts)
    : new StreamableHTTPClientTransport(url, opts);
}
