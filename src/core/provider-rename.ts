import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { CONFIG_PATH, MY_CLAW_DIR } from "./config.ts";
import { renameProvider } from "./config-edit.ts";
import { accountPath, moveAccount } from "../llm/accounts-store.ts";
import { META_FILE } from "../sessions/log.ts";
import { writeFileAtomically, writeJsonFileAtomically } from "../utils/atomic-write.ts";
import { log } from "../utils/logger.ts";

/**
 * One provider rename, everywhere the key is named.
 *
 * A provider key is not just a config entry: it prefixes every model reference
 * (`claude-2/claude-opus-5-5`), it is the name of the sign-in file, and it sits in tags, agent
 * pins, cron jobs, session overrides and agent files. `renameProvider` rewrites config.json in one
 * atomic write; this module completes the operation where the rest of the state lives, so a rename
 * never leaves a route silently falling back to the global default or a job pointing at a provider
 * that no longer exists (docs/providers-admin.md). The preview is the same walk, read-only,
 * answering what a rename would touch before anything is written.
 */

export interface ProviderRenameRefs {
  /** Declared models whose `provider` field or qualified `id` names it. */
  models: string[];
  /** Tag names whose route (or legacy single model) names it. */
  tags: string[];
  /** Config agent keys whose `llm` pin names it. */
  agents: string[];
  /** Session ids whose stored model override names it. */
  sessions: string[];
  /** Cron job ids whose model names it. */
  cron: string[];
  /** Agent files (editable tiers) whose `model:` frontmatter names it. */
  files: string[];
  /** A sign-in file moves with the key. */
  account: boolean;
}

const SESSIONS_ROOT = join(MY_CLAW_DIR, "sessions");
const CRON_FILE = join(MY_CLAW_DIR, "cron", "jobs.json");

/** Only a reference that names the provider travels: a bare id resolves by provider order. */
function namesFrom(from: string): (value: unknown) => boolean {
  return (value) => typeof value === "string" && value.startsWith(`${from}/`);
}

function retarget(value: string, from: string, to: string): string {
  return `${to}/${value.slice(from.length + 1)}`;
}

/** config.json's own references (tags, agent pins, declared models), read-only. */
async function configRefs(from: string): Promise<Pick<ProviderRenameRefs, "models" | "tags" | "agents">> {
  const models: string[] = [];
  const tags: string[] = [];
  const agents: string[] = [];
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(await readFile(CONFIG_PATH, "utf-8")) as Record<string, unknown>;
  } catch {
    return { models, tags, agents };
  }
  const is = namesFrom(from);
  const llm = (data["llm"] ?? {}) as Record<string, unknown>;
  const declared = llm["models"];
  if (Array.isArray(declared)) {
    for (const entry of declared) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const model = entry as Record<string, unknown>;
      if (model["provider"] === from || is(model["id"])) models.push(String(model["id"] ?? ""));
    }
  }
  const tagSection = data["tags"];
  if (tagSection && typeof tagSection === "object" && !Array.isArray(tagSection)) {
    for (const [name, entry] of Object.entries(tagSection as Record<string, unknown>)) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const tag = entry as Record<string, unknown>;
      const route = Array.isArray(tag["route"]) ? tag["route"] : [];
      const hit =
        is(tag["model"]) ||
        route.some((candidate) => candidate && typeof candidate === "object" && is((candidate as Record<string, unknown>)["model"]));
      if (hit) tags.push(name);
    }
  }
  const agentSection = data["agents"];
  if (agentSection && typeof agentSection === "object" && !Array.isArray(agentSection)) {
    for (const [key, entry] of Object.entries(agentSection as Record<string, unknown>)) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const pin = (entry as Record<string, unknown>)["llm"];
      if (!pin || typeof pin !== "object" || Array.isArray(pin)) continue;
      const cast = pin as Record<string, unknown>;
      if (cast["defaultProvider"] === from || is(cast["defaultModel"])) agents.push(key);
    }
  }
  return { models, tags, agents };
}

async function* sessionMetaFiles(): AsyncGenerator<{ id: string; path: string }> {
  const stack = [SESSIONS_ROOT];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
    if (!entries) continue;
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else if (entry.name === META_FILE) {
        const id = relative(SESSIONS_ROOT, dir);
        if (id) yield { id, path };
      }
    }
  }
}

/** Sessions whose stored model override names the provider. */
async function sessionRefs(from: string): Promise<Array<{ id: string; path: string }>> {
  const out: Array<{ id: string; path: string }> = [];
  const is = namesFrom(from);
  for await (const meta of sessionMetaFiles()) {
    const raw = await readFile(meta.path, "utf-8").catch(() => null);
    if (!raw) continue;
    try {
      const data = JSON.parse(raw) as Record<string, unknown>;
      if (is(data["modelOverride"])) out.push(meta);
    } catch {
      // A meta that does not parse is not a reference.
    }
  }
  return out;
}

/** Cron jobs whose model names the provider. */
async function cronRefs(from: string): Promise<string[]> {
  const is = namesFrom(from);
  try {
    const data = JSON.parse(await readFile(CRON_FILE, "utf-8")) as { jobs?: unknown };
    const jobs = Array.isArray(data.jobs) ? data.jobs : [];
    return jobs.flatMap((job) =>
      job && typeof job === "object" && is((job as Record<string, unknown>)["model"])
        ? [String((job as Record<string, unknown>)["id"] ?? "")]
        : [],
    );
  } catch {
    return [];
  }
}

/** The `model:` line of the frontmatter block, when it starts with `<from>/`. */
function frontmatterModelNames(raw: string, from: string): boolean {
  const lines = raw.split("\n");
  if (lines[0]?.trim() !== "---") return false;
  const end = lines.indexOf("---", 1);
  if (end === -1) return false;
  for (let i = 1; i < end; i++) {
    const match = lines[i]?.match(/^\s*model\s*:\s*(.+?)\s*$/);
    if (match && match[1]!.startsWith(`${from}/`)) return true;
  }
  return false;
}

function rewriteAgentModel(raw: string, from: string, to: string): string | null {
  const lines = raw.split("\n");
  if (lines[0]?.trim() !== "---") return null;
  const end = lines.indexOf("---", 1);
  if (end === -1) return null;
  for (let i = 1; i < end; i++) {
    const match = lines[i]?.match(/^(\s*model\s*:\s*)(.+?)\s*$/);
    if (!match) continue;
    const value = match[2]!;
    if (!value.startsWith(`${from}/`)) continue;
    lines[i] = `${match[1]}${retarget(value, from, to)}`;
    return lines.join("\n");
  }
  return null;
}

/** Agent files (any editable tier) whose `model:` frontmatter names the provider. */
async function agentFileRefs(from: string, dirs: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const dir of dirs) {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
    if (!entries) continue;
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const path = join(dir, entry.name);
      const raw = await readFile(path, "utf-8").catch(() => null);
      if (raw && frontmatterModelNames(raw, from)) out.push(path);
    }
  }
  return out;
}

/** What the rename would touch, read-only: what the app shows before the write. */
export async function previewProviderRename(from: string, to: string, agentDirs: string[]): Promise<ProviderRenameRefs> {
  const config = await configRefs(from);
  const account = await stat(accountPath(from)).then(() => true, () => false);
  return {
    ...config,
    sessions: (await sessionRefs(from)).map((meta) => meta.id),
    cron: await cronRefs(from),
    files: await agentFileRefs(from, agentDirs),
    account,
  };
}

/**
 * The rename itself: config.json through `renameProvider` (one atomic write), then every store
 * outside it, then the sign-in file. A store that fails to rewrite is logged, never silently
 * swallowed: the config half is committed by then, so reporting the whole operation as failed
 * would send the caller into a retry that finds the old key already gone.
 */
export async function renameProviderEverywhere(
  from: string,
  to: string,
  agentDirs: string[],
): Promise<{ ok: true; refs: ProviderRenameRefs } | { ok: false; error: string }> {
  let fromAccount: string;
  let toAccount: string;
  try {
    fromAccount = accountPath(from);
    toAccount = accountPath(to);
  } catch {
    return { ok: false, error: `Invalid provider key: "${to}"` };
  }
  const accountExists = await stat(fromAccount).then(() => true, () => false);
  if (accountExists && (await stat(toAccount).then(() => true, () => false))) {
    return { ok: false, error: `An account file already exists for "${to}"` };
  }

  const refs: ProviderRenameRefs = { models: [], tags: [], agents: [], sessions: [], cron: [], files: [], account: false };
  const failed: string[] = [];
  const config = await configRefs(from);
  const renamed = await renameProvider(from, to);
  if (!renamed.ok) return { ok: false, error: renamed.error };
  refs.models = config.models;
  refs.tags = config.tags;
  refs.agents = config.agents;

  for (const { id, path } of await sessionRefs(from)) {
    try {
      const data = JSON.parse(await readFile(path, "utf-8")) as Record<string, unknown>;
      data["modelOverride"] = retarget(data["modelOverride"] as string, from, to);
      await writeJsonFileAtomically(path, data, true);
      refs.sessions.push(id);
    } catch (err) {
      failed.push(`session ${id}`);
      void log("warn", "provider rename: session rewrite failed", { id, error: String(err) });
    }
  }

  const cronIds = await cronRefs(from);
  if (cronIds.length > 0) {
    try {
      const data = JSON.parse(await readFile(CRON_FILE, "utf-8")) as { jobs?: Array<Record<string, unknown>> };
      const is = namesFrom(from);
      for (const job of Array.isArray(data.jobs) ? data.jobs : []) {
        if (job && typeof job === "object" && is(job["model"])) job["model"] = retarget(job["model"] as string, from, to);
      }
      await writeJsonFileAtomically(CRON_FILE, data, true);
      refs.cron = cronIds;
    } catch (err) {
      failed.push("cron jobs");
      void log("warn", "provider rename: cron rewrite failed", { error: String(err) });
    }
  }

  for (const path of await agentFileRefs(from, agentDirs)) {
    try {
      const raw = await readFile(path, "utf-8");
      const rewritten = rewriteAgentModel(raw, from, to);
      if (!rewritten) continue;
      const mode = (await stat(path)).mode & 0o777;
      await writeFileAtomically(path, rewritten, { mode });
      refs.files.push(path);
    } catch (err) {
      failed.push(path);
      void log("warn", "provider rename: agent file rewrite failed", { path, error: String(err) });
    }
  }

  if (accountExists) {
    try {
      await moveAccount(from, to);
      refs.account = true;
    } catch (err) {
      failed.push("account");
      void log("warn", "provider rename: sign-in move failed", { error: String(err) });
    }
  }

  void log("info", "provider renamed everywhere", {
    from,
    to,
    tags: refs.tags.length,
    agents: refs.agents.length,
    sessions: refs.sessions.length,
    cron: refs.cron.length,
    files: refs.files.length,
    account: refs.account,
    ...(failed.length > 0 ? { failed } : {}),
  });
  return { ok: true, refs };
}
