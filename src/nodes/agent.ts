import { readFile, readdir, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { MY_CLAW_DIR } from "../core/config.ts";
import { writeFileAtomically } from "../utils/atomic-write.ts";
import { log } from "../utils/logger.ts";
import type { NodeFacts, NodeRecord } from "./types.ts";

/**
 * The agent file a node gets at pairing: one `agents/node-<slug>.md` per node, `base: node`.
 *
 * Generated once, then the owner's -- the facts in the description are what the machine said the
 * day it joined, and nothing here ever rewrites a file that parses. The live tool set comes from
 * the connection, never from this file, so a machine that adds a tool later needs no edit.
 */

export const NODE_AGENT_PREFIX = "node-";
const MAX_DESCRIPTION_CHARS = 1024;

export function nodeAgentsDir(): string {
  return join(MY_CLAW_DIR, "agents");
}

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "remote";
}

function toolList(facts: NodeFacts): string {
  const names = facts.tools.map((tool) => tool.name);
  if (names.length === 0) return "no tools";
  const shown = names.slice(0, 12).join(", ");
  return names.length > 12 ? `${shown}, …` : shown;
}

function descriptionOf(record: NodeRecord, facts: NodeFacts): string {
  const text = `Remote node "${record.name}" (${facts.os} ${facts.arch}, ${facts.mode} mode): ` +
    `${toolList(facts)}. Commands and files run on that machine, not locally. ` +
    `Complete this description: say what the machine is for, what it is connected to, and what must never be touched.`;
  return text.length > MAX_DESCRIPTION_CHARS ? text.slice(0, MAX_DESCRIPTION_CHARS) : text;
}

function promptOf(record: NodeRecord, facts: NodeFacts): string {
  return [
    `You are the agent of the remote node "${record.name}": ${facts.os} ${facts.arch}, user "${facts.user}",`,
    `${facts.mode} mode, node client ${facts.version}. Your tools run on that machine, not on the one`,
    `my-claw lives on: every call travels there and comes back. Report what you did and what the`,
    `machine answered; never claim a local path or a local command did the work.`,
    ``,
    `The paragraph above describes this machine. Complete it: what it hosts, what it is connected`,
    `to, and what must never be touched.`,
    ``,
  ].join("\n");
}

function fileText(record: NodeRecord, facts: NodeFacts): string {
  return [
    "---",
    `description: ${descriptionOf(record, facts)}`,
    "base: node",
    `node: ${record.nodeId}`,
    "---",
    "",
    promptOf(record, facts),
  ].join("\n");
}

function declaresNode(text: string, nodeId: string): boolean {
  return new RegExp(`^node:\\s*${nodeId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "m").test(text);
}

/**
 * Writes the agent file, or finds the one that already declares this node. A file already
 * declaring it is the owner's and is left exactly as it is; a name taken by another node's agent
 * moves to `-2`, `-3`, and so on.
 */
export async function writeNodeAgent(record: NodeRecord, facts: NodeFacts): Promise<string> {
  const dir = nodeAgentsDir();
  const base = `${NODE_AGENT_PREFIX}${slugify(record.name)}`;
  for (let suffix = 1; suffix <= 20; suffix++) {
    const name = suffix === 1 ? base : `${base}-${suffix}`;
    const path = join(dir, `${name}.md`);
    const existing = await readFile(path, "utf-8").catch(() => null);
    if (existing === null) {
      await writeFileAtomically(path, fileText(record, facts));
      void log("info", "node agent written", { nodeId: record.nodeId, agent: name, path });
      return name;
    }
    if (declaresNode(existing, record.nodeId)) return name;
  }
  void log("warn", "no free agent name for node", { nodeId: record.nodeId, base });
  return base;
}

/** Every agent file declaring this node: the app shows it, a revocation removes it. */
async function nodeAgentPaths(nodeId: string): Promise<string[]> {
  const dir = nodeAgentsDir();
  const entries = await readdir(dir).catch(() => [] as string[]);
  const paths: string[] = [];
  for (const entry of entries) {
    if (!entry.startsWith(NODE_AGENT_PREFIX) || !entry.endsWith(".md")) continue;
    const path = join(dir, entry);
    const text = await readFile(path, "utf-8").catch(() => null);
    if (text !== null && declaresNode(text, nodeId)) paths.push(path);
  }
  return paths;
}

/** The name of the node's agent file, absent once it was removed or renamed away. */
export async function nodeAgentName(nodeId: string): Promise<string | undefined> {
  const path = (await nodeAgentPaths(nodeId))[0];
  return path ? basename(path, ".md") : undefined;
}

/** Revocation takes the agent with it; only a file declaring this node is ever removed. */
export async function removeNodeAgent(nodeId: string): Promise<boolean> {
  const paths = await nodeAgentPaths(nodeId);
  for (const path of paths) {
    await unlink(path);
    void log("info", "node agent removed", { nodeId, path });
  }
  return paths.length > 0;
}
