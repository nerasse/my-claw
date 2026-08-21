/**
 * Display name for a tool, stripped of the MCP plumbing prefix.
 *
 * Kept for sessions persisted before the mirror cleanup: they still hold `mcp__myclaw__bash`,
 * the name the SDK gave our own tools. The card must show the tool, not the plumbing.
 */
const MCP_TOOL_PREFIX = "mcp__myclaw__";

export function toolDisplayName(name: string): string {
  return name.startsWith(MCP_TOOL_PREFIX) ? name.slice(MCP_TOOL_PREFIX.length) : name;
}
