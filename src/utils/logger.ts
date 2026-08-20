import { appendFile, mkdir, stat, readdir as fsReaddir, unlink as fsUnlink } from "node:fs/promises";
import { join } from "node:path";
import { MY_CLAW_DIR } from "../core/config.ts";
import { currentRunId } from "./run-context.ts";

const LOGS_DIR = join(MY_CLAW_DIR, "logs");
const MAX_LOG_FILE_BYTES = 5 * 1024 * 1024;

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error";
type AppLogLevel = Exclude<LogLevel, "trace">;

const LEVEL_ORDER: Record<LogLevel, number> = { trace: 0, debug: 1, info: 2, warn: 3, error: 4 };

export function parseLogLevel(value: string | undefined): LogLevel | undefined {
  const candidate = value?.trim().toLowerCase();
  return candidate && candidate in LEVEL_ORDER ? (candidate as LogLevel) : undefined;
}

/**
 * Floor for what reaches the files. Default `info`: `debug` is opt-in. Env wins over config so a
 * debug session never depends on editing (and reloading) config.json.
 */
const envLevel = parseLogLevel(process.env["MY_CLAW_LOG_LEVEL"]);
let configuredLevel: (() => LogLevel | undefined) | undefined;

/** Read live, so a hot-reloaded `logging.level` takes effect without a restart. */
export function setLogLevelSource(read: () => LogLevel | undefined): void {
  configuredLevel = read;
}

export function getLogLevel(): LogLevel {
  return envLevel ?? configuredLevel?.() ?? "info";
}

function shouldWrite(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[getLogLevel()];
}
type LogScope = "orchestrator" | "my-claw-app";
type ConsoleMode = "all" | "errors" | "none";

type ScopeState = {
  queue: Promise<void>;
  day?: string;
  index: number;
  size: number;
  initialized: boolean;
};

const scopeStates = new Map<LogScope, ScopeState>();
let logsDirReady: Promise<void> | null = null;

function ensureLogsDir(): Promise<void> {
  if (!logsDirReady) {
    logsDirReady = mkdir(LOGS_DIR, { recursive: true }).then(() => undefined).catch(() => undefined);
  }
  return logsDirReady;
}

function getScopeState(scope: LogScope): ScopeState {
  let state = scopeStates.get(scope);
  if (!state) {
    state = {
      queue: Promise.resolve(),
      index: 0,
      size: 0,
      initialized: false,
    };
    scopeStates.set(scope, state);
  }
  return state;
}

function logFilePath(scope: LogScope, day: string, index: number): string {
  const suffix = index === 0 ? "" : `.${index}`;
  return join(LOGS_DIR, `${scope}-${day}${suffix}.log`);
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

async function prepareScopeFile(scope: LogScope, day: string, state: ScopeState, incomingBytes: number): Promise<string> {
  if (!state.initialized || state.day !== day) {
    state.day = day;
    state.index = 0;
    state.size = await fileSize(logFilePath(scope, day, state.index));
    while (state.size >= MAX_LOG_FILE_BYTES) {
      state.index += 1;
      state.size = await fileSize(logFilePath(scope, day, state.index));
    }
    state.initialized = true;
  }

  while (state.size > 0 && state.size + incomingBytes > MAX_LOG_FILE_BYTES) {
    state.index += 1;
    state.size = await fileSize(logFilePath(scope, day, state.index));
  }

  return logFilePath(scope, day, state.index);
}

function consoleMethod(level: LogLevel): "log" | "warn" | "error" {
  if (level === "warn") return "warn";
  if (level === "error") return "error";
  return "log";
}

function shouldWriteToConsole(level: LogLevel, consoleMode: ConsoleMode): boolean {
  if (consoleMode === "none") return false;
  if (consoleMode === "errors") return level === "warn" || level === "error";
  return true;
}

function stringifyLogPart(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack ?? value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function normalizeLogData(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return stringifyLogPart(value);
  }
}

function printScopedConsole(scope: LogScope, level: LogLevel, message: string, consoleMode: ConsoleMode): void {
  if (!shouldWriteToConsole(level, consoleMode)) {
    return;
  }
  console[consoleMethod(level)](`[${scope.toUpperCase()}][${level.toUpperCase()}] ${message}`);
}

function enqueueScopedWrite(scope: LogScope, line: string, timestamp: string): Promise<void> {
  const state = getScopeState(scope);
  const day = timestamp.slice(0, 10);
  const incomingBytes = Buffer.byteLength(line);

  state.queue = state.queue
    .then(async () => {
      await ensureLogsDir();
      const path = await prepareScopeFile(scope, day, state, incomingBytes);
      await appendFile(path, line);
      state.size += incomingBytes;
    })
    .catch(() => undefined);

  return state.queue;
}

function createScopedLogger(scope: LogScope, options: { console?: ConsoleMode } = {}): (level: AppLogLevel, message: string, data?: unknown) => Promise<void> {
  const consoleMode = options.console ?? "all";
  return async (level: AppLogLevel, message: string, data?: unknown): Promise<void> => {
    if (!shouldWrite(level)) return;
    const timestamp = new Date().toISOString();
    // `run` is what makes these files usable: every line of one inbound message shares it.
    const run = currentRunId();
    const payload = JSON.stringify({
      timestamp,
      scope,
      level,
      ...(run ? { run } : {}),
      message,
      ...(data === undefined ? {} : { data: normalizeLogData(data) }),
    }) + "\n";

    printScopedConsole(scope, level, message, consoleMode);
    await enqueueScopedWrite(scope, payload, timestamp);
  };
}

const orchestratorLogger = createScopedLogger("orchestrator");

export const myClawAppLog = createScopedLogger("my-claw-app", { console: "errors" });

export async function log(level: AppLogLevel, message: string, data?: unknown): Promise<void> {
  await orchestratorLogger(level, message, data);
}

const LOG_RETENTION_DAYS = 30;

export async function pruneOldLogs(): Promise<void> {
  try {
    await mkdir(LOGS_DIR, { recursive: true });
    const entries = await fsReaddir(LOGS_DIR);
    const cutoff = Date.now() - LOG_RETENTION_DAYS * 86_400_000;
    for (const name of entries) {
      if (!name.endsWith(".log")) continue;
      const filePath = join(LOGS_DIR, name);
      try {
        const s = await stat(filePath);
        if (s.mtimeMs < cutoff) {
          await fsUnlink(filePath);
        }
      } catch {
        // skip
      }
    }
  } catch {
    // best-effort
  }
}
