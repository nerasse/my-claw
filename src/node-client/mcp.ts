import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { McpServerConfig } from "../core/config.ts";
import { buildTransport, mcpToolName, withDeadline } from "../mcp/transport.ts";
import type { NodeAttachment, NodeMcpStatus, NodeToolManifest } from "../nodes/types.ts";
import type { NodeToolResult } from "./tools.ts";

/**
 * The MCP servers a node runs on its own machine: Godot, Blender, whatever lives there.
 *
 * The server hands the list over (`node.config`), the node persists it and starts each one with
 * the transport its config names. Their tools join the node's manifest under the same namespace
 * the server's own MCP uses (`mcp__<server>__<tool>`), so an agent sees one shape wherever a tool
 * comes from -- and a call travels the ordinary `node.call` path, dispatched here by that name.
 */

const CLIENT_INFO = { name: "my-claw-node", version: "0.1.0" };
const CONNECT_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 120_000;
/** A server that went away is retried quietly, like the server-side manager does. */
const RECONNECT_MS = 30_000;
const MAX_SERVERS = 32;
const MAX_DESCRIPTION = 1024;
const MAX_PARAMETERS_BYTES = 16 * 1024;

export type NodeMcpLog = (level: "info" | "warn" | "error", message: string, data?: Record<string, unknown>) => void;
export type NodeUpload = (bytes: Uint8Array, filename: string, mimeType?: string) => Promise<NodeAttachment | undefined>;

interface ServerState {
  name: string;
  config: McpServerConfig;
  client?: Client;
  tools: Array<{ remoteName: string; manifest: NodeToolManifest }>;
  status: NodeMcpStatus;
  reconnect?: ReturnType<typeof setTimeout>;
}

interface ContentBlock {
  type?: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

function schemaOf(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { type: "object", properties: {} };
  try {
    return JSON.stringify(raw).length > MAX_PARAMETERS_BYTES ? { type: "object", properties: {} } : (raw as Record<string, unknown>);
  } catch {
    return { type: "object", properties: {} };
  }
}

export class NodeMcpHub {
  private servers = new Map<string, ServerState>();
  private closed = false;

  constructor(private readonly deps: { log: NodeMcpLog; upload?: NodeUpload }) {}

  /** Applies a whole list: what changed is restarted, what went away is closed, the rest is kept. */
  async apply(mcp: Record<string, McpServerConfig>): Promise<void> {
    const wanted = Object.entries(mcp).slice(0, MAX_SERVERS);
    const names = new Set(wanted.map(([name]) => name));
    for (const [name, state] of [...this.servers]) {
      const next = mcp[name];
      if (next && JSON.stringify(next) === JSON.stringify(state.config)) continue;
      await this.stop(name);
    }
    for (const [name, config] of wanted) {
      if (!names.has(name) || config.enabled === false || this.servers.has(name)) continue;
      const state: ServerState = { name, config, tools: [], status: { name, ok: false, tools: 0 } };
      this.servers.set(name, state);
      await this.connect(state);
    }
  }

  private async connect(state: ServerState): Promise<void> {
    if (this.closed || this.servers.get(state.name) !== state) return;
    try {
      const client = new Client(CLIENT_INFO, { capabilities: {} });
      await withDeadline(client.connect(buildTransport(state.config)), CONNECT_TIMEOUT_MS, `MCP ${state.name}: connect timed out`);
      const { tools } = await withDeadline(client.listTools(), CONNECT_TIMEOUT_MS, `MCP ${state.name}: listTools timed out`);
      state.client = client;
      state.tools = tools.map(tool => ({
        remoteName: tool.name,
        manifest: {
          name: mcpToolName(state.name, tool.name),
          description: (tool.description ?? `MCP tool ${tool.name} from ${state.name}`).slice(0, MAX_DESCRIPTION),
          parameters: schemaOf(tool.inputSchema),
        },
      }));
      state.status = { name: state.name, ok: true, tools: state.tools.length };
      client.onclose = () => this.lost(state);
      client.onerror = () => this.lost(state);
      this.deps.log("info", "mcp connected", { server: state.name, tools: state.tools.length });
    } catch (err) {
      state.client = undefined;
      state.tools = [];
      const error = String((err as Error | undefined)?.message ?? err).slice(0, 300);
      state.status = { name: state.name, ok: false, tools: 0, error };
      this.deps.log("warn", "mcp failed", { server: state.name, error });
      this.scheduleReconnect(state);
    }
  }

  private lost(state: ServerState): void {
    if (state.client === undefined) return;
    state.client = undefined;
    state.tools = [];
    state.status = { name: state.name, ok: false, tools: 0, error: "the server went away" };
    this.deps.log("warn", "mcp disconnected", { server: state.name });
    this.scheduleReconnect(state);
  }

  private scheduleReconnect(state: ServerState): void {
    if (this.closed || state.reconnect) return;
    state.reconnect = setTimeout(() => {
      state.reconnect = undefined;
      void this.connect(state);
    }, RECONNECT_MS);
  }

  private async stop(name: string): Promise<void> {
    const state = this.servers.get(name);
    if (!state) return;
    this.servers.delete(name);
    if (state.reconnect) clearTimeout(state.reconnect);
    const client = state.client;
    state.client = undefined;
    state.tools = [];
    if (client) {
      client.onclose = undefined;
      client.onerror = undefined;
    }
    await client?.close().catch(() => undefined);
  }

  /** The MCP tools of every live server, in the node's manifest shape. */
  manifest(): NodeToolManifest[] {
    return [...this.servers.values()].flatMap(state => state.tools.map(tool => tool.manifest));
  }

  /** How each server came up, announced in the hello so the app can say so. */
  statuses(): NodeMcpStatus[] {
    return [...this.servers.values()].map(state => state.status);
  }

  /** Dispatches by the namespaced name; null means the name is not an MCP tool of this node. */
  async call(toolName: string, args: Record<string, unknown>): Promise<NodeToolResult | null> {
    for (const state of this.servers.values()) {
      const prefix = `mcp__${state.name}__`;
      if (!toolName.startsWith(prefix)) continue;
      const remoteName = toolName.slice(prefix.length);
      if (!state.client) return { ok: false, output: "", error: `MCP server ${state.name} is not connected` };
      try {
        const result = (await state.client.callTool({ name: remoteName, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS })) as {
          content?: ContentBlock[];
          isError?: boolean;
        };
        const { text, attachments } = await this.contentOf(state.name, result.content ?? []);
        const failed = result.isError === true;
        return {
          ok: !failed,
          output: text,
          ...(failed ? { error: text || "MCP tool reported an error" } : {}),
          ...(attachments.length > 0 ? { attachments } : {}),
        };
      } catch (err) {
        return { ok: false, output: "", error: `MCP call failed: ${String(err)}` };
      }
    }
    return null;
  }

  /** Text becomes the output; an image block goes back to the server as a file it can see. */
  private async contentOf(server: string, blocks: ContentBlock[]): Promise<{ text: string; attachments: NodeAttachment[] }> {
    const parts: string[] = [];
    const attachments: NodeAttachment[] = [];
    for (const block of blocks) {
      if (block?.type === "text" && typeof block.text === "string") {
        parts.push(block.text);
        continue;
      }
      if (block?.type === "image" && typeof block.data === "string" && this.deps.upload) {
        const extension = (block.mimeType ?? "image/png").split("/")[1]?.split("+")[0] ?? "png";
        const uploaded = await this.deps.upload(Buffer.from(block.data, "base64"), `${server}.${extension}`, block.mimeType);
        if (uploaded) {
          attachments.push(uploaded);
          parts.push(`[image attached: ${block.mimeType ?? "image"}]`);
          continue;
        }
      }
      parts.push(JSON.stringify(block));
    }
    return { text: parts.join("\n"), attachments };
  }

  async closeAll(): Promise<void> {
    this.closed = true;
    for (const name of [...this.servers.keys()]) await this.stop(name);
  }
}
