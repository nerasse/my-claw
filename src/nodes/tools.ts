import type { Tool } from "../tools/types.ts";
import { callNodeTool, nodeFactsOf, nodeNameOf } from "./hub.ts";
import { nodeRecord } from "./store.ts";

/**
 * The tools of a connected node, as the agent of that node sees them.
 *
 * They are not in the ToolRegistry: a remote tool exists only while its machine is connected, and
 * only its own agent may hold it. The bridge asks for the set when it runs a `base: node` agent,
 * so a node that is away yields `null` -- and the run says so instead of starting blind.
 */
export function nodeToolsFor(
  nodeId: string,
  options: { allow?: readonly string[]; disabled?: readonly string[] } = {},
): Tool[] | null {
  const facts = nodeFactsOf(nodeId);
  if (!facts) return null;
  const record = nodeRecord(nodeId);
  const exposed = record?.tools;
  const approval = record?.approval === true;
  const name = nodeNameOf(nodeId);

  let tools: Tool[] = facts.tools
    .filter((manifest) => !exposed || exposed.includes(manifest.name))
    .map((manifest) => ({
      name: manifest.name,
      description: `${manifest.description}\n\nThis tool runs on the remote node "${name}", not on this machine.`,
      parameters: manifest.parameters,
      ...(approval ? { requiresApproval: true } : {}),
      execute: (args) => callNodeTool(nodeId, manifest.name, args, { signal: signalOf(args) }),
    }));

  // The file's `tools:` narrows the manifest exactly like it narrows a local baseline, and the
  // config denylist applies on top: a name outside the set is dropped, never added.
  if (options.allow) tools = tools.filter((tool) => options.allow!.includes(tool.name));
  if (options.disabled?.length) tools = tools.filter((tool) => !options.disabled!.includes(tool.name));
  return tools;
}

/** Names of the tools a connected node offers; used to treat their output as remote content. */
export function nodeToolNamesFor(nodeId: string): string[] {
  return nodeFactsOf(nodeId)?.tools.map((tool) => tool.name) ?? [];
}

function signalOf(args: Record<string, unknown>): AbortSignal | undefined {
  const signal = args["__signal"];
  return signal instanceof AbortSignal ? signal : undefined;
}
