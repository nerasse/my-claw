import { readFile, readdir, rename, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { MY_CLAW_DIR } from "../core/config.ts";
import { writeFileAtomically } from "../utils/atomic-write.ts";
import { parseFrontmatter } from "../utils/frontmatter.ts";
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

/** An agent file of a node: what the app shows, and what a rename or a description edits. */
export interface NodeAgentFile {
  name: string;
  path: string;
  description?: string;
}

/** Every agent file declaring this node: the app shows the first, a revocation removes them all. */
async function nodeAgentFiles(nodeId: string): Promise<NodeAgentFile[]> {
  const dir = nodeAgentsDir();
  const entries = await readdir(dir).catch(() => [] as string[]);
  const files: NodeAgentFile[] = [];
  for (const entry of entries) {
    if (!entry.startsWith(NODE_AGENT_PREFIX) || !entry.endsWith(".md")) continue;
    const path = join(dir, entry);
    const text = await readFile(path, "utf-8").catch(() => null);
    if (text === null || !declaresNode(text, nodeId)) continue;
    const description = parseFrontmatter(text)?.fields["description"];
    files.push({ name: basename(path, ".md"), path, ...(description ? { description } : {}) });
  }
  return files;
}

/** The agent file of a node, absent once it was removed or renamed away. */
export async function nodeAgentFile(nodeId: string): Promise<NodeAgentFile | undefined> {
  return (await nodeAgentFiles(nodeId))[0];
}

/** The name of the node's agent file, absent once it was removed or renamed away. */
export async function nodeAgentName(nodeId: string): Promise<string | undefined> {
  return (await nodeAgentFile(nodeId))?.name;
}

/**
 * Rewrites the `description:` line of the node's agent file, and nothing else: the prompt below
 * the header is the owner's, and a description is one line by construction.
 */
export async function setNodeAgentDescription(nodeId: string, description: string): Promise<{ ok: boolean; error?: string }> {
  const file = await nodeAgentFile(nodeId);
  if (!file) return { ok: false, error: "this node has no agent file" };
  const text = await readFile(file.path, "utf-8").catch(() => null);
  if (text === null) return { ok: false, error: "the agent file could not be read" };
  const value = description.trim().replace(/\s+/g, " ");
  if (!value) return { ok: false, error: "a description is required" };
  if (value.length > MAX_DESCRIPTION_CHARS) return { ok: false, error: `descriptions are at most ${MAX_DESCRIPTION_CHARS} characters` };
  const header = /^---\s*\n([\s\S]*?)\n---\s*\n/.exec(text);
  if (!header) return { ok: false, error: "the agent file has no frontmatter" };
  const lines = header[1]!.split("\n");
  const at = lines.findIndex((line) => /^description\s*:/.test(line));
  if (at === -1) lines.unshift(`description: ${value}`);
  else lines[at] = `description: ${value}`;
  await writeFileAtomically(file.path, `---\n${lines.join("\n")}\n---\n${text.slice(header[0].length)}`);
  void log("info", "node agent described", { nodeId, agent: file.name, chars: value.length });
  return { ok: true };
}

/**
 * Renames the node's agent file to match a new node name, content untouched. A taken name is
 * refused rather than suffixed: a rename that quietly lands on `node-web-2` is a surprise.
 */
export async function renameNodeAgent(nodeId: string, name: string): Promise<{ ok: true; agent: string } | { ok: false; error: string }> {
  const file = await nodeAgentFile(nodeId);
  if (!file) return { ok: false, error: "this node has no agent file" };
  const target = `${NODE_AGENT_PREFIX}${slugify(name)}`;
  if (target === file.name) return { ok: true, agent: file.name };
  const path = join(nodeAgentsDir(), `${target}.md`);
  const taken = await readFile(path, "utf-8").catch(() => null);
  if (taken !== null) return { ok: false, error: `an agent file named ${target} already exists` };
  await rename(file.path, path);
  void log("info", "node agent renamed", { nodeId, from: file.name, to: target });
  return { ok: true, agent: target };
}

/** Revocation takes the agent with it; only a file declaring this node is ever removed. */
export async function removeNodeAgent(nodeId: string): Promise<boolean> {
  const files = await nodeAgentFiles(nodeId);
  for (const file of files) {
    await unlink(file.path);
    void log("info", "node agent removed", { nodeId, path: file.path });
  }
  return files.length > 0;
}
