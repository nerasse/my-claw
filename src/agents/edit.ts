import { mkdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { contentSha, snapshot } from "../core/config-store.ts";
import { writeFileAtomically } from "../utils/atomic-write.ts";
import { agentNameOf, parseAgentFile } from "./loader.ts";
import type { AgentBase } from "./types.ts";
import type { PromptLayerName } from "../agent/prompt/files.ts";

/**
 * Read/write of agent definition files (`agents/<name>.md`) from the app.
 *
 * The file is the definition layer: the config override sits above it, the built-in sync sits
 * below. Everything here mirrors the instructions editor's contract — a sha round-trip, a refusal
 * on conflict, validation through the *same* `parseAgentFile` the loader uses so a file written
 * here is a file the registry will accept (the last-good retention never has to kick in for an
 * edit the app made). The agent watcher (`src/agents/watcher.ts`) already reloads the registry on
 * write, so hot reload needs no extra wiring here.
 */

export interface AgentFileDoc {
  text: string;
  sha: string;
}

export async function readAgentFile(path: string): Promise<AgentFileDoc | null> {
  try {
    const text = await readFile(path, "utf-8");
    return { text, sha: contentSha(text) };
  } catch {
    return null;
  }
}

export type AgentFileWriteResult =
  | { ok: true; sha: string }
  | { ok: false; conflict: boolean; error: string };

export async function writeAgentFile(path: string, text: string, sha: string | undefined, name: string): Promise<AgentFileWriteResult> {
  const current = await readAgentFile(path);
  if (current !== null && sha !== undefined && current.sha !== sha) {
    return { ok: false, conflict: true, error: "changed on the server since it was opened" };
  }
  const parsed = parseAgentFile(text, name, path);
  if ("rejected" in parsed) {
    return { ok: false, conflict: false, error: `agent file rejected: ${parsed.rejected}` };
  }
  await snapshot(path, { origin: "pre-write", note: `avant agent ${name}` });
  await writeFileAtomically(path, text);
  return { ok: true, sha: contentSha(text) };
}

export type AgentFileCreateResult =
  | { ok: true; path: string }
  | { ok: false; error: string };

export async function createAgentFile(customDir: string, name: string, description: string, body = ""): Promise<AgentFileCreateResult> {
  const check = agentNameOf(`${name}.md`);
  if ("rejected" in check) {
    return { ok: false, error: `invalid agent name: "${name}"` };
  }
  const path = join(customDir, `${name}.md`);
  if (await readAgentFile(path)) {
    return { ok: false, error: `agent already exists: ${name}` };
  }
  const text = serializeAgentFile({ description, skillsMode: "absent", mcpMode: "absent" }, body);
  if ("rejected" in parseAgentFile(text, name, path)) {
    return { ok: false, error: "agent file rejected: invalid frontmatter" };
  }
  await mkdir(customDir, { recursive: true });
  await writeFileAtomically(path, text);
  return { ok: true, path };
}

export async function deleteAgentFile(path: string): Promise<void> {
  await unlink(path);
}

export interface AgentFileFields {
  description: string;
  base?: AgentBase;
  tools?: string[];
  skillsMode: "absent" | "all" | "list";
  skills?: string[];
  mcpMode: "absent" | "all" | "list";
  mcp?: string[];
  model?: string;
  workspace?: string;
  maxIterations?: number;
  contextCap?: number;
  instructions?: PromptLayerName[];
}

/** The flat `key: value` frontmatter the parser reads, in the loader's own field order. Values are
 *  flattened to one line on purpose: the parser is line-based, so a newline in a value would
 *  silently truncate the file at the next read. The body is kept verbatim. */
export function serializeAgentFile(fields: AgentFileFields, body: string): string {
  const lines = ["---"];
  const push = (key: string, value: string | undefined): void => {
    if (value === undefined || value === "") return;
    lines.push(`${key}: ${value.replace(/\s+/g, " ").trim()}`);
  };
  push("description", fields.description);
  push("base", fields.base);
  push("tools", fields.tools?.join(", "));
  if (fields.skillsMode === "all") push("skills", "*");
  else if (fields.skillsMode === "list") push("skills", (fields.skills ?? []).join(", "));
  if (fields.mcpMode === "all") push("mcp", "*");
  else if (fields.mcpMode === "list") push("mcp", (fields.mcp ?? []).join(", "));
  push("model", fields.model);
  push("workspace", fields.workspace);
  push("maxIterations", fields.maxIterations?.toString());
  push("contextCap", fields.contextCap?.toString());
  push("instructions", fields.instructions?.join(", "));
  lines.push("---");
  const trimmed = body.replace(/^\n+/, "");
  return `${lines.join("\n")}\n\n${trimmed}${trimmed.endsWith("\n") ? "" : "\n"}`;
}

/** Maps a parsed `AgentMeta` back to the structured fields the app edits. */
export function fieldsOfMeta(meta: {
  description: string;
  base?: AgentBase;
  tools?: string[];
  skills?: string[] | "all";
  mcp?: string[] | "all";
  model?: string;
  workspace?: string;
  maxIterations?: number;
  contextCap?: number;
  instructions?: PromptLayerName[];
}): AgentFileFields {
  return {
    description: meta.description,
    ...(meta.base ? { base: meta.base } : {}),
    ...(meta.tools ? { tools: meta.tools } : {}),
    skillsMode: meta.skills === undefined ? "absent" : meta.skills === "all" ? "all" : "list",
    ...(meta.skills && meta.skills !== "all" ? { skills: meta.skills } : {}),
    mcpMode: meta.mcp === undefined ? "absent" : meta.mcp === "all" ? "all" : "list",
    ...(meta.mcp && meta.mcp !== "all" ? { mcp: meta.mcp } : {}),
    ...(meta.model ? { model: meta.model } : {}),
    ...(meta.workspace ? { workspace: meta.workspace } : {}),
    ...(meta.maxIterations !== undefined ? { maxIterations: meta.maxIterations } : {}),
    ...(meta.contextCap !== undefined ? { contextCap: meta.contextCap } : {}),
    ...(meta.instructions ? { instructions: meta.instructions } : {}),
  };
}
