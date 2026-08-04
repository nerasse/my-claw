import { appendFile, mkdir, stat, readdir as fsReaddir, unlink as fsUnlink } from "node:fs/promises";
import { join } from "node:path";
import { MY_CLAW_DIR } from "../core/config.ts";

const LOGS_DIR = join(MY_CLAW_DIR, "logs");
const MAX_LOG_FILE_BYTES = 5 * 1024 * 1024;

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error";
type AppLogLevel = Exclude<LogLevel, "trace">;
type LogScope = "orchestrator" | "matrix" | "matrix-sdk" | "telegram" | "mobile";
type ConsoleMode = "all" | "errors" | "none";

type ScopedSdkLogger = {
  trace(...msg: unknown[]): void;
  debug(...msg: unknown[]): void;
  info(...msg: unknown[]): void;
  warn(...msg: unknown[]): void;
  error(...msg: unknown[]): void;
  log(...msg: unknown[]): void;
  getChild(namespace: string): ScopedSdkLogger;
};

type MatrixSdkRootLogger = {
  methodFactory?: (
    methodName: string,
    logLevel: number,
    loggerName: string,
  ) => (this: { prefix?: string }, ...args: unknown[]) => void;
  rebuild?: () => void;
};

type ScopeState = {
  queue: Promise<void>;
  day?: string;
  index: number;
  size: number;
  initialized: boolean;
};

const scopeStates = new Map<LogScope, ScopeState>();
let logsDirReady: Promise<void> | null = null;
let matrixSdkRootInstalled = false;

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
    const timestamp = new Date().toISOString();
    const payload = JSON.stringify({
      timestamp,
      scope,
      level,
      message,
      ...(data === undefined ? {} : { data: normalizeLogData(data) }),
    }) + "\n";

    printScopedConsole(scope, level, message, consoleMode);
    await enqueueScopedWrite(scope, payload, timestamp);
  };
}

class FileSdkLogger implements ScopedSdkLogger {
  constructor(
    private readonly scope: Extract<LogScope, "matrix-sdk">,
    private readonly namespace: string,
    private readonly consoleMode: ConsoleMode,
  ) {}

  trace(...msg: unknown[]): void {
    this.write("trace", msg);
  }

  debug(...msg: unknown[]): void {
    this.write("debug", msg);
  }

  info(...msg: unknown[]): void {
    this.write("info", msg);
  }

  warn(...msg: unknown[]): void {
    this.write("warn", msg);
  }

  error(...msg: unknown[]): void {
    this.write("error", msg);
  }

  log(...msg: unknown[]): void {
    this.write("debug", msg);
  }

  getChild(namespace: string): ScopedSdkLogger {
    return new FileSdkLogger(this.scope, `${this.namespace}${namespace}`, this.consoleMode);
  }

  private write(level: LogLevel, parts: unknown[]): void {
    const timestamp = new Date().toISOString();
    const message = parts.map((part) => stringifyLogPart(part)).join(" ");
    const payload = JSON.stringify({
      timestamp,
      scope: this.scope,
      namespace: this.namespace,
      level,
      message,
      ...(parts.length === 0 ? {} : { data: parts.map((part) => normalizeLogData(part)) }),
    }) + "\n";

    printScopedConsole(this.scope, level, message, this.consoleMode);
    void enqueueScopedWrite(this.scope, payload, timestamp);
  }
}

const orchestratorLogger = createScopedLogger("orchestrator");

export const matrixLog = createScopedLogger("matrix", { console: "errors" });
export const telegramLog = createScopedLogger("telegram", { console: "errors" });
export const mobileLog = createScopedLogger("mobile", { console: "errors" });

export function createSdkLogger(
  scope: Extract<LogScope, "matrix-sdk">,
  options: { console?: ConsoleMode; namespace?: string } = {},
): ScopedSdkLogger {
  return new FileSdkLogger(scope, options.namespace ?? scope, options.console ?? "none");
}

export function installMatrixSdkRootLogger(rootLogger: unknown): void {
  if (matrixSdkRootInstalled) {
    return;
  }

  const logger = rootLogger as MatrixSdkRootLogger;
  if (typeof logger.rebuild !== "function") {
    return;
  }

  const sink = createSdkLogger("matrix-sdk");
  logger.methodFactory = function (methodName: string, _logLevel: number, loggerName: string) {
    return function (this: { prefix?: string }, ...args: unknown[]): void {
      const prefix = typeof this?.prefix === "string" && this.prefix ? this.prefix : loggerName;
      const parts = prefix ? [prefix, ...args] : args;
      switch (methodName) {
        case "trace":
          sink.trace(...parts);
          break;
        case "debug":
          sink.debug(...parts);
          break;
        case "warn":
          sink.warn(...parts);
          break;
        case "error":
          sink.error(...parts);
          break;
        case "info":
          sink.info(...parts);
          break;
        default:
          sink.log(...parts);
          break;
      }
    };
  };
  logger.rebuild();
  matrixSdkRootInstalled = true;
}

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
