import type { Tool, ToolResult } from "../tools/types.ts";
import { callNodeTool, nodeFactsOf, nodeNameOf } from "./hub.ts";
import { nodeRecord } from "./store.ts";

/**
 * The tools of a connected node, as the agent of that node sees them.
 *
 * They are not in the ToolRegistry: a remote tool exists only while its machine is connected, and
 * only its own agent may hold it. The bridge asks for the set when it runs a `base: node` agent,
 * so a node that is away yields `null` -- and the run says so instead of starting blind.
 *
 * What the owner changes in the app is read again on every call rather than frozen here: the
 * approval flag is a getter, and the subset and the on/off switch are checked in `execute`. A run
 * in flight follows the settings from its next turn on, which is what "the settings apply at the
 * run" means for a remote machine.
 */
export function nodeToolsFor(
  nodeId: string,
  options: { allow?: readonly string[]; disabled?: readonly string[] } = {},
): Tool[] | null {
  const facts = nodeFactsOf(nodeId);
  if (!facts) return null;
  const record = nodeRecord(nodeId);
  const exposed = record?.tools;
  const name = nodeNameOf(nodeId);

  let tools: Tool[] = facts.tools
    .filter((manifest) => !exposed || exposed.includes(manifest.name))
    .map((manifest) => ({
      name: manifest.name,
      description: `${manifest.description}\n\nThis tool runs on the remote node "${name}", not on this machine.`,
      parameters: manifest.parameters,
      get requiresApproval(): boolean {
        return nodeRecord(nodeId)?.approval === true;
      },
      execute: (args) => {
        const current = nodeRecord(nodeId);
        if (!current) return refused(`node "${name}" is not paired any more`);
        if (current.disabled === true) return refused(`node "${name}" is switched off; turn it back on in Settings > Nodes`);
        if (current.tools && !current.tools.includes(manifest.name)) {
          return refused(`tool "${manifest.name}" is no longer exposed on node "${name}"`);
        }
        return callNodeTool(nodeId, manifest.name, args, { signal: signalOf(args) });
      },
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

function refused(error: string): Promise<ToolResult> {
  return Promise.resolve({ success: false, output: "", error });
}

function signalOf(args: Record<string, unknown>): AbortSignal | undefined {
  const signal = args["__signal"];
  return signal instanceof AbortSignal ? signal : undefined;
}
