import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpServerConfig } from "../core/config.ts";
import type { Tool, ToolResult } from "../tools/types.ts";

const CLIENT_INFO = { name: "my-claw", version: "0.1.0" };
const CALL_TIMEOUT_MS = 120_000;

// Tools are namespaced so an external server cannot shadow a built-in tool name and
// two servers cannot collide. The agent sees mcp__<server>__<tool>.
export function mcpToolName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`;
}

interface McpContentText {
  type: string;
  text?: string;
}

function contentToText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content as McpContentText[]) {
    if (block && block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    } else if (block) {
      // Non-text block (image/resource): keep a JSON marker so the model sees something.
      parts.push(JSON.stringify(block));
    }
  }
  return parts.join("\n");
}

function buildTransport(config: McpServerConfig): Transport {
  if (config.transport === "stdio") {
    if (!config.command) throw new Error("stdio MCP server requires 'command'");
    return new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      // env REPLACES the child environment; merge over the SDK's safe defaults so the
      // server still gets PATH etc. plus the config-declared extras.
      env: { ...getDefaultEnvironment(), ...(config.env ?? {}) },
    });
  }
  if (!config.url) throw new Error(`${config.transport} MCP server requires 'url'`);
  const url = new URL(config.url);
  const opts = config.headers ? { requestInit: { headers: config.headers } } : undefined;
  return config.transport === "sse"
    ? new SSEClientTransport(url, opts)
    : new StreamableHTTPClientTransport(url, opts);
}

/**
 * One connection to an external MCP server, plus the adaptation of its tools into the
 * my-claw Tool interface. Lifecycle is owned by McpManager.
 */
export class McpConnection {
  private client: Client | undefined;
  private tools: Tool[] = [];

  constructor(
    private readonly name: string,
    private readonly config: McpServerConfig,
  ) {}

  async connect(): Promise<void> {
    const client = new Client(CLIENT_INFO, { capabilities: {} });
    await client.connect(buildTransport(this.config));
    this.client = client;
    await this.refreshTools();
  }

  private async refreshTools(): Promise<void> {
    if (!this.client) return;
    const { tools } = await this.client.listTools();
    this.tools = tools.map((t) => this.adaptTool(t.name, t.description ?? "", t.inputSchema));
  }

  private adaptTool(remoteName: string, description: string, inputSchema: unknown): Tool {
    const schema = (inputSchema && typeof inputSchema === "object")
      ? (inputSchema as Record<string, unknown>)
      : { type: "object", properties: {} };
    return {
      name: mcpToolName(this.name, remoteName),
      description: description || `MCP tool ${remoteName} from ${this.name}`,
      parameters: schema,
      execute: async (args: Record<string, unknown>): Promise<ToolResult> => {
        if (!this.client) return { success: false, output: "", error: `MCP server ${this.name} is not connected` };
        try {
          const res = await this.client.callTool(
            { name: remoteName, arguments: args },
            undefined,
            { timeout: CALL_TIMEOUT_MS },
          );
          const output = contentToText((res as { content?: unknown }).content);
          if ((res as { isError?: boolean }).isError) {
            return { success: false, output, error: output || "MCP tool reported an error" };
          }
          return { success: true, output };
        } catch (err) {
          return { success: false, output: "", error: `MCP call failed: ${String(err)}` };
        }
      },
    };
  }

  getTools(): Tool[] {
    return this.tools;
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.tools = [];
    await client?.close().catch(() => undefined);
  }
}
