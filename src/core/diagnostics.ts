/**
 * Remote diagnostics: the log files, filtered and redacted, plus a one-shot health snapshot
 * meant to be copy-pasted out of a phone. Everything here is read-only.
 *
 * Secrets are stripped before anything leaves this module: the logs carry whatever a channel
 * or a tool put in them, and this output is designed to be pasted into a chat.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { MY_CLAW_DIR, type MyClawConfig } from "./config.ts";
import { getLogLevel, type LogLevel } from "../utils/logger.ts";

const LOGS_DIR = join(MY_CLAW_DIR, "logs");
const LEVEL_ORDER: Record<string, number> = { trace: 0, debug: 1, info: 2, warn: 3, error: 4 };

export interface LogEntry {
  timestamp: string;
  scope: string;
  level: string;
  run?: string;
  message: string;
  data?: unknown;
}

export interface LogQuery {
  scope?: string;
  /** Minimum level, e.g. "warn" keeps warn and error. */
  level?: LogLevel;
  /** Only the lines of one run id: the whole point of stamping it. */
  run?: string;
  limit?: number;
  /** Substring match on the message, case-insensitive. */
  contains?: string;
}

/** Newest first. Reads whole files: they are capped at 5 MB by the rotation. */
export async function readLogEntries(query: LogQuery = {}): Promise<LogEntry[]> {
  const limit = Math.min(Math.max(query.limit ?? 200, 1), 2000);
  const minLevel = LEVEL_ORDER[query.level ?? "trace"] ?? 0;
  const needle = query.contains?.toLowerCase();

  let files: string[];
  try {
    files = (await readdir(LOGS_DIR)).filter((f) => f.endsWith(".log"));
  } catch {
    return [];
  }
  if (query.scope) files = files.filter((f) => f.startsWith(`${query.scope}-`));

  const dated = await Promise.all(
    files.map(async (name) => {
      try {
        return { name, mtime: (await stat(join(LOGS_DIR, name))).mtimeMs };
      } catch {
        return { name, mtime: 0 };
      }
    }),
  );
  dated.sort((a, b) => b.mtime - a.mtime);

  const out: LogEntry[] = [];
  for (const { name } of dated) {
    let content: string;
    try {
      content = await readFile(join(LOGS_DIR, name), "utf8");
    } catch {
      continue;
    }
    const lines = content.split("\n");
    // Within a file, walk backwards: the tail is what a diagnosis needs.
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      const line = lines[i]!.trim();
      if (!line) continue;
      let entry: LogEntry;
      try {
        entry = JSON.parse(line) as LogEntry;
      } catch {
        continue;
      }
      if ((LEVEL_ORDER[entry.level] ?? 0) < minLevel) continue;
      if (query.run && entry.run !== query.run) continue;
      if (needle && !entry.message.toLowerCase().includes(needle)) continue;
      out.push(entry);
    }
    if (out.length >= limit) break;
  }
  return out;
}

/** Every secret the config can name, plus what its env vars hold. */
export function collectSecrets(config: MyClawConfig): string[] {
  const secrets = new Set<string>();
  const add = (value: unknown): void => {
    if (typeof value === "string" && value.length >= 8) secrets.add(value);
  };
  const addEnv = (name: unknown): void => {
    if (typeof name === "string") add(process.env[name]);
  };

  add(config.llm.apiKey);
  for (const provider of Object.values(config.llm.providers ?? {})) {
    addEnv(provider.apiKeyEnv);
    for (const header of Object.values(provider.headers ?? {})) add(header);
  }
  add(config.channels.telegram?.token);
  add(config.channels.matrix?.password);
  add(config.channels.matrix?.accessToken);
  for (const device of Object.values(config.channels.mobile?.devices ?? {})) add(device.token);
  add(config.webSearch?.token);
  return [...secrets];
}

const SECRET_PATTERNS: RegExp[] = [
  // Bearer tokens and the common provider key shapes, for anything not named in the config.
  /\b(Bearer\s+)[A-Za-z0-9._\-]{12,}/gi,
  /\bsk-[A-Za-z0-9._\-]{12,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  /\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/g,
];

export function redactSecrets(text: string, secrets: string[]): string {
  let out = text;
  // Longest first: a short secret that is a prefix of a longer one must not mask it partially.
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    out = out.split(secret).join("[redacted]");
  }
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (match, prefix: string | undefined) => `${prefix ?? ""}[redacted]`);
  }
  return out;
}

export function formatLogEntries(entries: LogEntry[], secrets: string[]): string {
  const lines = entries
    .slice()
    .reverse()
    .map((e) => {
      const run = e.run ? ` run=${e.run}` : "";
      const data = e.data === undefined ? "" : ` ${JSON.stringify(e.data)}`;
      return `${e.timestamp} ${e.level.toUpperCase().padEnd(5)} ${e.scope}${run} ${e.message}${data}`;
    });
  return redactSecrets(lines.join("\n"), secrets);
}

/** The tarball ships package.json next to src/, so this resolves in dev and in prod alike. */
let cachedVersion: string | undefined;
export async function readAppVersion(): Promise<string> {
  if (cachedVersion) return cachedVersion;
  try {
    const raw = await readFile(join(import.meta.dir, "..", "..", "package.json"), "utf8");
    cachedVersion = (JSON.parse(raw) as { version?: string }).version ?? "unknown";
  } catch {
    cachedVersion = "unknown";
  }
  return cachedVersion;
}

export interface DiagnosticsInput {
  config: MyClawConfig;
  liveChannels: string[];
  session?: { id: string; messages: number; model?: string; lastActiveAt?: string };
  /** Resolved for the caller's session, since it depends on overrides. */
  model?: { id: string; vision?: boolean; backend?: string };
}

function human(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * One block, copy-paste ready. Ordered by what a diagnosis needs first: what is running, then
 * what it decided, then what went wrong.
 */
export async function buildDiagnostics(input: DiagnosticsInput): Promise<string> {
  const secrets = collectSecrets(input.config);
  const lines: string[] = [];

  lines.push(`my-claw ${await readAppVersion()} | bun ${process.versions.bun ?? "?"} | ${process.platform}`);
  lines.push(`uptime ${Math.floor(process.uptime())}s | rss ${human(process.memoryUsage().rss)}`);
  lines.push(`channels up: ${input.liveChannels.join(", ") || "none"}`);
  lines.push(`log level: ${getLogLevel()}`);

  if (input.model) {
    const vision = input.model.vision ? "vision" : "no vision";
    lines.push(`model: ${input.model.id} (${vision}${input.model.backend ? `, ${input.model.backend}` : ""})`);
    lines.push(`vision fallback: ${input.config.llm.visionFallback ?? "none"}`);
  }
  if (input.session) {
    lines.push(`session: ${input.session.id}`);
    lines.push(`messages: ${input.session.messages}${input.session.lastActiveAt ? ` | last active ${input.session.lastActiveAt}` : ""}`);
  }

  const mobile = input.config.channels.mobile;
  if (mobile) {
    const devices = Object.keys(mobile.devices ?? {}).length;
    lines.push(`mobile: port ${mobile.port ?? 8080} | ${devices} device(s) | approvals ${mobile.approvals === true ? "on" : "off"} | streaming ${mobile.streaming?.enabled === false ? "off" : "on"}`);
  }

  const errors = await readLogEntries({ level: "warn", limit: 15 });
  lines.push("", `last ${errors.length} warnings/errors:`);
  lines.push(errors.length > 0 ? formatLogEntries(errors, secrets) : "  none");

  return redactSecrets(lines.join("\n"), secrets);
}
