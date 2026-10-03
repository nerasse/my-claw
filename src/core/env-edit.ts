import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomically } from "../utils/atomic-write.ts";
import { MY_CLAW_DIR } from "./config.ts";
import { snapshot, journal, artifactId } from "./config-store.ts";

/**
 * The one writer of ~/.my-claw/.env.
 *
 * The loader (`loadEnv`) is line-based and order-preserving, and the file carries comments the
 * installers put there, so edits are line-based too: parse and reserialise would flatten both.
 * A rename keeps the value of the line it renames, whatever was on it, including a comment
 * sitting on the same line.
 *
 * The file is secrets: mode is forced to 0600 (atomic write defaults to 0644), and the module
 * only ever returns names, never values. `process.env` is patched alongside the file because
 * `loadEnv` never deletes: a renamed key would otherwise live on in the process.
 */

export const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const envPath = (): string => join(MY_CLAW_DIR, ".env");

async function readEnv(): Promise<{ ok: true; lines: string[]; mode: number } | { ok: false; error: string }> {
  let raw: string;
  try {
    raw = await readFile(envPath(), "utf-8");
  } catch {
    // Absent file: treated as empty, the write below creates it.
    return { ok: true, lines: [], mode: 0o600 };
  }
  const mode = await stat(envPath()).then((s) => s.mode & 0o777, () => 0o600);
  const lines = raw.split("\n");
  // The split leaves a trailing "" behind the final newline; it is not a blank line of the file.
  if (lines[lines.length - 1] === "") lines.pop();
  return { ok: true, lines, mode };
}

function keyOfLine(line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return undefined;
  const eq = trimmed.indexOf("=");
  if (eq === -1) return undefined;
  return trimmed.slice(0, eq).trim();
}

/** The split keeps a trailing "" after the final newline; one newline at the end is the file shape. */
function joinEnv(lines: string[]): string {
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

/** The names present in .env, in file order. Never the values. */
export async function envKeys(): Promise<string[]> {
  const read = await readEnv();
  if (!read.ok) return [];
  const keys: string[] = [];
  for (const line of read.lines) {
    const key = keyOfLine(line);
    if (key) keys.push(key);
  }
  return keys;
}

export type EnvEditResult = { ok: true } | { ok: false; error: string };

/** Writes one `NAME=value` line: replaces the existing one in place, appends when new. */
export async function setEnvValue(name: string, value: string): Promise<EnvEditResult> {
  if (!ENV_NAME_RE.test(name)) return { ok: false, error: `invalid environment variable name: ${name}` };
  if (!value) return { ok: false, error: "an empty value would be skipped by the loader; refusing" };

  const read = await readEnv();
  if (!read.ok) return read;
  const lines = [...read.lines];
  const at = lines.findIndex((line) => keyOfLine(line) === name);
  const line = `${name}=${value}`;
  if (at === -1) lines.push(line);
  else lines[at] = line;

  await snapshot(envPath(), { origin: "pre-write", note: `avant écriture ${name} dans .env` });
  await writeFileAtomically(envPath(), joinEnv(lines), { mode: 0o600 });
  await journal("edit", artifactId(envPath()), { name, kind: at === -1 ? "add" : "set" });
  process.env[name] = value;
  return { ok: true };
}

/** Renames a line in place, value and trailing comment preserved. */
export async function renameEnvKey(from: string, to: string): Promise<EnvEditResult> {
  if (!ENV_NAME_RE.test(to)) return { ok: false, error: `invalid environment variable name: ${to}` };
  if (from === to) return { ok: false, error: "the new name is the same as the old one" };

  const read = await readEnv();
  if (!read.ok) return read;
  const at = read.lines.findIndex((line) => keyOfLine(line) === from);
  if (at === -1) return { ok: false, error: `no ${from} line in .env` };
  if (read.lines.some((line) => keyOfLine(line) === to)) {
    return { ok: false, error: `${to} is already in .env; rename would create a duplicate line` };
  }
  const rest = read.lines[at]!.trim().slice(from.length + 1);
  const lines = [...read.lines];
  lines[at] = `${to}=${rest}`;

  await snapshot(envPath(), { origin: "pre-write", note: `avant renommage ${from} -> ${to} dans .env` });
  await writeFileAtomically(envPath(), joinEnv(lines), { mode: 0o600 });
  await journal("edit", artifactId(envPath()), { from, to, kind: "rename" });
  process.env[to] = process.env[from];
  delete process.env[from];
  return { ok: true };
}

/** Drops the line. The key goes from the process too: the loader never deletes. */
export async function removeEnvKey(name: string): Promise<EnvEditResult> {
  const read = await readEnv();
  if (!read.ok) return read;
  const lines = read.lines.filter((line) => keyOfLine(line) !== name);
  if (lines.length === read.lines.length) return { ok: true };

  await snapshot(envPath(), { origin: "pre-write", note: `avant suppression ${name} de .env` });
  await writeFileAtomically(envPath(), joinEnv(lines), { mode: 0o600 });
  await journal("edit", artifactId(envPath()), { name, kind: "remove" });
  delete process.env[name];
  return { ok: true };
}
