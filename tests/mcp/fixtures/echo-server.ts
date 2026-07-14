// Minimal real MCP server over stdio, used by the MCP e2e tests. Exposes one `echo` tool
// and one `boom` tool (always errors) so the client adapter can be exercised end to end.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "echo-server", version: "1.0.0" });

server.registerTool(
  "echo",
  { description: "Echo back the provided text", inputSchema: { text: z.string() } },
  async ({ text }) => ({ content: [{ type: "text", text: `echo: ${text}` }] }),
);

server.registerTool(
  "boom",
  { description: "Always fails", inputSchema: {} },
  async () => ({ content: [{ type: "text", text: "kaboom" }], isError: true }),
);

await server.connect(new StdioServerTransport());
