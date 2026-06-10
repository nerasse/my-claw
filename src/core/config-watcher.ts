/** @file Config hot-reload: watch ~/.my-claw/config.json and apply safe changes in place. */

import { watch, type FSWatcher } from "node:fs";
import { dirname, basename } from "node:path";
import { hooks } from "../hooks/index.ts";
import { log } from "../utils/logger.ts";
import { CONFIG_PATH, readConfigFromDisk, type MyClawConfig } from "./config.ts";

const DEBOUNCE_MS = 300;

// Channel fields that cannot be hot-swapped on a live adapter. Telegram bakes the token into
// the Grammy Bot + polling loop; Matrix derives its E2E crypto store from the identity/token.
const TELEGRAM_REBOOT_FIELDS = ["enabled", "token", "mode", "webhook"];
const MATRIX_REBOOT_FIELDS = [
  "enabled",
  "homeserver",
  "accessToken",
  "userId",
  "password",
  "deviceId",
  "encryption",
  "initialSyncLimit",
];

// Top-level sections wired at boot (timers, clients, env) that need a restart to re-apply.
const REBOOT_SECTIONS = ["memory", "voice", "cron", "workspace"] as const;

// Object sections read live through the shared root config object on every use.
const HOT_OBJECT_SECTIONS = ["llm", "agents", "injection", "browser", "webSearch"] as const;
// Array sections whose identity must be preserved (consumers hold the same array reference).
const HOT_ARRAY_SECTIONS = ["whitelist", "blacklist"] as const;

export interface ReloadResult {
  /** Hot sections that were applied in place. */
  changed: string[];
  /** Fields that changed but require a reboot; left untouched. */
  rebootRequired: string[];
}

interface ChannelTarget {
  setWhitelist(whitelist: Set<string>): void;
  applyConfigReload(): void;
}

export interface ConfigReloadContext {
  modelPicker?: { setModels(models: { id: string; label: string }[]): void };
  getTelegram?: () => ChannelTarget | undefined;
  getMatrix?: () => ChannelTarget | undefined;
  normalizeMatrixUserId?: (id: string) => string;
  registerWebSearch?: () => void;
}

export interface ConfigWatcherOptions {
  /** Override the watched file path (defaults to CONFIG_PATH). Used in tests. */
  path?: string;
  /** Override how the next config is read/parsed (defaults to readConfigFromDisk). Used in tests. */
  read?: () => Promise<MyClawConfig>;
  /** Override the debounce delay in ms (defaults to 300). Used in tests. */
  debounceMs?: number;
}

function eq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * Replace the contents of `target` with `source` while keeping `target`'s identity.
 * Critical: consumers that captured a sub-object reference at boot keep seeing updates.
 */
function replaceContents(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  preserve: string[] = [],
): void {
  for (const key of Object.keys(target)) {
    if (preserve.includes(key)) continue;
    if (!(key in source)) delete target[key];
  }
  for (const key of Object.keys(source)) {
    if (preserve.includes(key)) continue;
    target[key] = source[key];
  }
}

function replaceArray<T>(target: T[], source: T[]): void {
  target.splice(0, target.length, ...source);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function applyObjectSection(
  rec: Record<string, unknown>,
  nextRec: Record<string, unknown>,
  key: string,
  changed: string[],
): void {
  if (eq(rec[key], nextRec[key])) return;
  const src = nextRec[key];
  const tgt = rec[key];
  if (src === undefined) {
    if (isPlainObject(tgt)) replaceContents(tgt, {});
  } else if (isPlainObject(tgt) && isPlainObject(src)) {
    replaceContents(tgt, src);
  } else {
    rec[key] = src;
  }
  changed.push(key);
}

function behavioralDiffers(
  cur: Record<string, unknown>,
  nxt: Record<string, unknown>,
  rebootFields: string[],
): boolean {
  const keys = new Set([...Object.keys(cur), ...Object.keys(nxt)]);
  for (const k of keys) {
    if (rebootFields.includes(k)) continue;
    if (!eq(cur[k], nxt[k])) return true;
  }
  return false;
}

function applyChannelReload(
  name: "telegram" | "matrix",
  current: MyClawConfig,
  next: MyClawConfig,
  rebootFields: string[],
  changed: string[],
  rebootRequired: string[],
): void {
  const cur = current.channels?.[name] as Record<string, unknown> | undefined;
  const nxt = next.channels?.[name] as Record<string, unknown> | undefined;

  if (!cur && !nxt) return;
  if (!cur || !nxt) {
    // Channel added or removed entirely -> needs adapter (re)creation.
    rebootRequired.push(`channels.${name}`);
    return;
  }

  for (const field of rebootFields) {
    if (!eq(cur[field], nxt[field])) rebootRequired.push(`channels.${name}.${field}`);
  }

  if (behavioralDiffers(cur, nxt, rebootFields)) {
    replaceContents(cur, nxt, rebootFields);
    changed.push(`channels.${name}`);
  }
}

/**
 * Diff `next` against `current` and apply the hot-reloadable changes by mutating `current`
 * in place. Returns which sections were applied and which require a reboot.
 * Pure with respect to side effects beyond mutating `current` (no I/O, no appliers).
 */
export function applyHotReload(current: MyClawConfig, next: MyClawConfig): ReloadResult {
  const changed: string[] = [];
  const rebootRequired: string[] = [];
  const rec = current as unknown as Record<string, unknown>;
  const nextRec = next as unknown as Record<string, unknown>;

  for (const key of HOT_OBJECT_SECTIONS) {
    applyObjectSection(rec, nextRec, key, changed);
  }

  for (const key of HOT_ARRAY_SECTIONS) {
    if (eq(current[key], next[key])) continue;
    replaceArray(current[key], next[key] ?? []);
    changed.push(key);
  }

  applyChannelReload("telegram", current, next, TELEGRAM_REBOOT_FIELDS, changed, rebootRequired);
  applyChannelReload("matrix", current, next, MATRIX_REBOOT_FIELDS, changed, rebootRequired);

  for (const key of REBOOT_SECTIONS) {
    if (!eq(rec[key], nextRec[key])) rebootRequired.push(key);
  }

  return { changed, rebootRequired };
}

/** Run the side-effecting appliers for sections that snapshot config at boot. */
export function runReloadAppliers(
  changed: string[],
  config: MyClawConfig,
  ctx: ConfigReloadContext,
): void {
  if (changed.includes("llm") && ctx.modelPicker) {
    ctx.modelPicker.setModels((config.llm.models ?? []).map((m) => ({ id: m.id, label: m.label })));
  }
  if (changed.includes("whitelist")) {
    ctx.getTelegram?.()?.setWhitelist(new Set(config.whitelist));
    const norm = ctx.normalizeMatrixUserId ?? ((x: string) => x);
    ctx.getMatrix?.()?.setWhitelist(new Set(config.whitelist.map(norm)));
  }
  if (changed.includes("channels.telegram")) ctx.getTelegram?.()?.applyConfigReload();
  if (changed.includes("channels.matrix")) ctx.getMatrix?.()?.applyConfigReload();
  if (changed.includes("webSearch")) ctx.registerWebSearch?.();
  // agents, injection, browser, blacklist are read live through the shared config; no applier.
}

/**
 * Start watching config.json and hot-reload safe sections on change.
 * Invalid JSON or read errors are logged and skipped (the running config is kept).
 * Returns a stop function.
 */
export function startConfigWatcher(
  config: MyClawConfig,
  ctx: ConfigReloadContext,
  options: ConfigWatcherOptions = {},
): () => void {
  const path = options.path ?? CONFIG_PATH;
  const read = options.read ?? readConfigFromDisk;
  const debounceMs = options.debounceMs ?? DEBOUNCE_MS;
  const dir = dirname(path);
  const file = basename(path);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let watcher: FSWatcher | undefined;

  const reload = async (): Promise<void> => {
    let next: MyClawConfig;
    try {
      next = await read();
    } catch (err) {
      void log("warn", "config reload skipped: failed to read/parse config.json", { error: String(err) });
      return;
    }

    const result = applyHotReload(config, next);
    if (result.changed.length === 0 && result.rebootRequired.length === 0) return;

    try {
      runReloadAppliers(result.changed, config, ctx);
    } catch (err) {
      void log("error", "config reload appliers failed", { error: String(err) });
    }

    void log("info", "config reloaded", {
      changed: result.changed,
      rebootRequired: result.rebootRequired,
    });
    if (result.rebootRequired.length > 0) {
      void log("warn", "config changes require a reboot to take effect", { fields: result.rebootRequired });
    }
    hooks.emit("config:reloaded", { changed: result.changed, rebootRequired: result.rebootRequired });
  };

  try {
    watcher = watch(dir, (_event, filename) => {
      if (filename && basename(filename.toString()) !== file) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void reload(), debounceMs);
    });
  } catch (err) {
    void log("warn", "config watcher could not start", { error: String(err) });
  }

  return () => {
    if (timer) clearTimeout(timer);
    watcher?.close();
  };
}
