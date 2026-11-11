import type { Tool, ToolResult } from "../tools/types.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import { callNodeTool, nodeFactsOf, nodeNameOf, putFileToNode } from "./hub.ts";
import { nodeAsksFirst, nodeRecord } from "./store.ts";

/**
 * The tools a node agent holds that run on this server rather than on the machine: `skills`, and
 * only in its read-only shape.
 *
 * A skill is knowledge, not a command: nothing it carries executes through the socket, so handing
 * it to a node agent leaks nothing to the remote machine. It is not optional either -- the prompt's
 * layer 5 lists the catalog for whatever scope the agent has, so a node agent without the tool is
 * told to call something it does not hold. One exception, like `send_file_to_node`, for the same
 * reason: the prompt and the set must agree. Writing stays the orchestrator's.
 */
export function nodeServerToolsFor(registry: ToolRegistry): Tool[] {
  const skills = registry.get("skills")?.readOnly;
  return skills ? [skills] : [];
}

/**
 * The tools of a connected node, as the agent of that node sees them.
 *
 * They are not in the ToolRegistry: a remote tool exists only while its machine is connected, and
 * only its own agent may hold it. The bridge asks for the set when it runs a `base: node` agent,
 * so a node that is away yields `null` -- and the run says so instead of starting blind.
 *
 * What the owner changes in the app is read again rather than frozen here: the bridge rebuilds
 * this set before every turn of a run, the approval flag is a getter, and `execute` checks the
 * record once more so a call already in flight when a switch moved is refused with the reason.
 */
export function nodeToolsFor(
  nodeId: string,
  options: { allow?: readonly string[]; disabled?: readonly string[]; serverTools?: readonly Tool[] } = {},
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
        return nodeAsksFirst(nodeRecord(nodeId));
      },
      approvalOrigin: { kind: "node", nodeId },
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

  // The file direction the node's own tools cannot do: they write text, and an asset is bytes.
  // Added before the file's `tools:` and the denylist are applied, so a restriction that does not
  // name it does not hand it out: a name outside the set is dropped, never added.
  tools.push({
    name: "send_file_to_node",
    description: `Send a file from this server to the remote node "${name}", which fetches it and writes it under its working directory. Use it to hand that machine an asset (an image, a scene, a texture) before a tool there needs it.`,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path of the file on this server." },
      },
      required: ["path"],
    },
    get requiresApproval(): boolean {
      return nodeAsksFirst(nodeRecord(nodeId));
    },
    approvalOrigin: { kind: "node", nodeId },
    execute: async (args) => {
      const path = typeof args["path"] === "string" ? args["path"].trim() : "";
      if (!path) return { success: false, output: "", error: "path is required" };
      if (!(await Bun.file(path).exists())) return { success: false, output: "", error: `no file at ${path}` };
      const sent = await putFileToNode(nodeId, path);
      if (!sent.ok) return { success: false, output: "", error: sent.error ?? "the file could not be sent" };
      return { success: true, output: `Sent to the node at ${sent.path ?? "its working directory"}.` };
    },
  });

  // Tools that run on this server, not on the machine: `send_file_to_node` above, and whatever the
  // caller hands over. They go through the same two filters as everything else, so a file's
  // `tools:` that does not name one does not grant it.
  if (options.serverTools) tools.push(...options.serverTools);

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
