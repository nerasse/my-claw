// A real MCP server over stdio that answers with an image, for the node's upload path: the node
// has to ship the bytes to the server that asked, because the model reads text and files.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

/** A 1x1 PNG. */
const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const server = new McpServer({ name: "image-server", version: "1.0.0" });

server.registerTool("screenshot", { description: "One pixel", inputSchema: {} }, async () => ({
  content: [{ type: "image", data: PIXEL, mimeType: "image/png" }],
}));

await server.connect(new StdioServerTransport());
