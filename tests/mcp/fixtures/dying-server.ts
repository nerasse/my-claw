// An MCP server that goes away on its own, used to prove the manager notices. Real servers die
// like this all the time: a crash, an OOM kill, a `docker stop` on the thing behind them.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({ name: "dying-server", version: "1.0.0" });

server.registerTool(
  "quit",
  { description: "Exit the process, without a goodbye", inputSchema: {} },
  async () => {
    // Answered first, so the call itself is not what fails: the point is the silence after it.
    setTimeout(() => process.exit(0), 10);
    return { content: [{ type: "text", text: "bye" }] };
  },
);

await server.connect(new StdioServerTransport());
