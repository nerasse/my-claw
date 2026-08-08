/** @file Config hot-reload: watch ~/.my-claw/config.json and apply safe changes in place. */

import { watch, type FSWatcher } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, basename } from "node:path";
import { hooks } from "../hooks/index.ts";
import { log } from "../utils/logger.ts";
import {
  CONFIG_PATH,
  readConfigFromDisk,
  resolveWorkspaceDir,
  HOT_OBJECT_SECTIONS,
  HOT_ARRAY_SECTIONS,
  type MyClawConfig,
} from "./config.ts";
import { snapshot, reject, confirm, readQuarantine, contentSha, HEALTH_GATE_MS } from "./config-store.ts";

const DEBOUNCE_MS = 300;

// Channel fields that cannot be hot-swapped on a live adapter. Telegram bakes the token into
// the Grammy Bot + polling loop; Matrix derives its E2E crypto store from the identity/token.
// The my-claw-app WSS server binds its socket at start, so its identity is the listen port.
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
const MY_CLAW_APP_REBOOT_FIELDS = ["enabled", "port"];

// Top-level sections wired at boot (timers, clients, env) that need a restart to re-apply.
// Only `workspace` remains: changing the path would require re-seeding templates and
// re-resolving every tool's cwd. memory/voice/cron are hot (see appliers below).
const REBOOT_SECTIONS = ["workspace"] as const;

// HOT_OBJECT_SECTIONS / HOT_ARRAY_SECTIONS live in config.ts: parseConfig's structural guard needs
// the same lists, and a second copy here would drift from it.
// `voice` is pure live-read (VoiceManager reads config.voice per call, no applier).
// `mcp`/`cron`/`memory` are applied in place too but also drive side-effecting appliers.

export interface ReloadResult {
  /** Hot sections that were applied in place. */
  changed: string[];
  /** Fields that changed but require a reboot; left untouched. */
  rebootRequired: string[];
  /** Sections whose identity changed and are applied in place but need a live recreate (e.g. a channel adapter). */
  recreate: string[];
}

interface ChannelTarget {
  setWhitelist(whitelist: Set<string>): void;
  applyConfigReload(): void;
}

export interface ConfigReloadContext {
  modelPicker?: {
    syncFromConfig(llm: import("./config.ts").LlmConfig, tags?: Record<string, import("./config.ts").TagConfig>): void;
  };
  // Owns the base/discovered merge into config.llm.models + the picker sync. When provided it
  // supersedes the built-in modelPicker sync (which only knows the curated config models).
  syncModels?: () => void;
  getTelegram?: () => ChannelTarget | undefined;
  getMatrix?: () => ChannelTarget | undefined;
  normalizeMatrixUserId?: (id: string) => string;
  registerWebSearch?: () => void;
  syncMcp?: (mcp: MyClawConfig["mcp"]) => void;
  reloadCron?: () => void;
  reloadMemory?: (memory: MyClawConfig["memory"]) => void;
  recreateTelegram?: () => void;
  /** Re-scan the skill layers: the workspace list is hot, so new keys take effect without a restart. */
  reloadSkills?: () => void;
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
  name: "telegram" | "matrix" | "my-claw-app",
  current: MyClawConfig,
  next: MyClawConfig,
  rebootFields: string[],
  changed: string[],
  rebootRequired: string[],
  recreate: string[],
  supportsRecreate: boolean,
): void {
  const cur = current.channels?.[name] as Record<string, unknown> | undefined;
  const nxt = next.channels?.[name] as Record<string, unknown> | undefined;

  if (!cur && !nxt) return;
  if (!cur || !nxt) {
    // Adding/removing a channel entirely still needs a reboot (adapter instantiation/teardown
    // + approval-handler wiring); rarer and riskier than an identity swap.
    rebootRequired.push(`channels.${name}`);
    return;
  }

  const identityChanged = rebootFields.some((f) => !eq(cur[f], nxt[f]));

  if (supportsRecreate && identityChanged) {
    // Sequential adapter recreate: apply the whole section in place (incl. identity) so the
    // factory reads the new token/mode, and signal a recreate. stop-old-before-start-new
    // avoids the concurrent-instance hazards (Telegram 409, Matrix crypto store contention).
    replaceContents(cur, nxt);
    recreate.push(`channels.${name}`);
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
  const recreate: string[] = [];
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

  // Telegram supports a live identity recreate (grammy bot.stop() is clean; a sequential swap
  // avoids the 409). Matrix stays reboot-only until its live-homeserver Megolm test passes.
  // Devices/tokens/streaming are read live per connection; only the socket (port) is
  // reboot-bound.
  applyChannelReload("telegram", current, next, TELEGRAM_REBOOT_FIELDS, changed, rebootRequired, recreate, true);
  applyChannelReload("matrix", current, next, MATRIX_REBOOT_FIELDS, changed, rebootRequired, recreate, false);
  applyChannelReload("my-claw-app", current, next, MY_CLAW_APP_REBOOT_FIELDS, changed, rebootRequired, recreate, false);

  for (const key of REBOOT_SECTIONS) {
    // Normalized on both sides: boot resolves workspace to an absolute path, so comparing it
    // raw against a file that usually omits the key flagged a reboot on every single reload.
    if (!eq(resolveWorkspaceDir(rec[key] as string | undefined), resolveWorkspaceDir(nextRec[key] as string | undefined))) {
      rebootRequired.push(key);
    }
  }

  return { changed, rebootRequired, recreate };
}

/** Run the side-effecting appliers for sections that snapshot config at boot. */
export function runReloadAppliers(
  changed: string[],
  config: MyClawConfig,
  ctx: ConfigReloadContext,
  recreate: string[] = [],
): void {
  // Identity recreate: stop the old adapter and start a fresh one with the new config.
  if (recreate.includes("channels.telegram")) ctx.recreateTelegram?.();
  if (changed.includes("llm") || changed.includes("tags")) {
    // The resolver reads tags off the llm view; a section reload drops the attached reference
    // (replaceContents deletes keys absent from the file), so it is re-attached here.
    config.llm.tags = config.tags;
    if (ctx.syncModels) {
      ctx.syncModels();
    } else if (ctx.modelPicker) {
      ctx.modelPicker.syncFromConfig(config.llm, config.tags);
    }
  }
  if (changed.includes("whitelist")) {
    ctx.getTelegram?.()?.setWhitelist(new Set(config.whitelist));
    const norm = ctx.normalizeMatrixUserId ?? ((x: string) => x);
    ctx.getMatrix?.()?.setWhitelist(new Set(config.whitelist.map(norm)));
  }
  if (changed.includes("channels.telegram")) ctx.getTelegram?.()?.applyConfigReload();
  if (changed.includes("channels.matrix")) ctx.getMatrix?.()?.applyConfigReload();
  if (changed.includes("webSearch")) ctx.registerWebSearch?.();
  // mcp is applied in place for live reads, but connections must be (re)opened/closed too.
  if (changed.includes("mcp")) ctx.syncMcp?.(config.mcp);
  // cron: enabled/tickIntervalMs are captured at start(), so re-arm the tick timer.
  if (changed.includes("cron")) ctx.reloadCron?.();
  // memory: recall knobs are live, but a changed embedding model needs a re-warm + backfill.
  if (changed.includes("memory")) ctx.reloadMemory?.(config.memory);
  // workspaces: added keys open new skills layers; the watcher re-targets on its own tier list.
  if (changed.includes("workspaces")) ctx.reloadSkills?.();
  // agents, injection, browser, tools, skills, voice, blacklist are read live through the shared config; no applier.
}

export interface ConfigWatcherHandle {
  stop: () => void;
  /** Re-read and apply now, returning what changed. Used by `/config rollback`. */
  reloadNow: () => Promise<ReloadResult>;
}

/**
 * Start watching config.json and hot-reload safe sections on change.
 * Invalid JSON or read errors are logged, archived, and skipped (the running config is kept).
 */
export function startConfigWatcher(
  config: MyClawConfig,
  ctx: ConfigReloadContext,
  options: ConfigWatcherOptions = {},
): ConfigWatcherHandle {
  const path = options.path ?? CONFIG_PATH;
  const read = options.read ?? readConfigFromDisk;
  const debounceMs = options.debounceMs ?? DEBOUNCE_MS;
  const dir = dirname(path);
  const file = basename(path);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let confirmTimer: ReturnType<typeof setTimeout> | undefined;
  let watcher: FSWatcher | undefined;

  const NO_CHANGE: ReloadResult = { changed: [], rebootRequired: [], recreate: [] };

  const reload = async (): Promise<ReloadResult> => {
    // A quarantined content must not come back through a save: it parses, so nothing else would
    // stop it, and re-applying it would undo the revert that just recovered the channel.
    const rawNow = await readFile(path, "utf-8").catch(() => null);
    if (rawNow !== null) {
      const q = await readQuarantine();
      if (q && q.sha === contentSha(rawNow)) {
        void log("warn", "config reload skipped: content is quarantined", { reason: q.reason });
        return NO_CHANGE;
      }
    }

    let next: MyClawConfig;
    try {
      next = await read();
    } catch (err) {
      void log("warn", "config reload skipped: failed to read/parse config.json", { error: String(err) });
      // Archive what was refused: the owner fixes the file within seconds, and the failed attempt
      // is then the only thing that could have explained why the edit never applied.
      const raw = await readFile(path, "utf-8").catch(() => null);
      if (raw !== null) await reject(path, raw, String(err));
      return NO_CHANGE;
    }

    // applyHotReload sat outside both guards: a throw here became an unhandled rejection, which
    // index.ts turns into process.exit(1) -- a bad edit could take the whole agent down.
    let result: ReloadResult;
    try {
      result = applyHotReload(config, next);
    } catch (err) {
      void log("error", "config reload failed while applying", { error: String(err) });
      return NO_CHANGE;
    }
    if (result.changed.length === 0 && result.rebootRequired.length === 0 && result.recreate.length === 0) {
      // read() already force-refreshed process.env; a bare .env rotation lands here
      // with no config-section diff. Confirm it so a token rotation is observable.
      void log("info", "config watcher fired with no section changes (env refreshed)");
      return result;
    }

    try {
      runReloadAppliers(result.changed, config, ctx, result.recreate);
    } catch (err) {
      void log("error", "config reload appliers failed", { error: String(err) });
    }

    void log("info", "config reloaded", {
      changed: result.changed,
      rebootRequired: result.rebootRequired,
      recreate: result.recreate,
    });
    if (result.rebootRequired.length > 0) {
      void log("warn", "config changes require a reboot to take effect", { fields: result.rebootRequired });
    }
    // The diff is the most useful thing a debugger can have and it is computed exactly once, here.
    await snapshot(path, {
      origin: "reload",
      changed: result.changed,
      rebootRequired: result.rebootRequired,
    });
    // Same gate as boot: a reload that kills the process must not be promoted. Re-armed on each
    // reload, so a burst of edits is confirmed once, 60s after the last one settles.
    if (confirmTimer) clearTimeout(confirmTimer);
    confirmTimer = setTimeout(() => void confirm(path), HEALTH_GATE_MS);
    confirmTimer.unref?.();
    hooks.emit("config:reloaded", { changed: result.changed, rebootRequired: result.rebootRequired });
    return result;
  };

  try {
    watcher = watch(dir, (_event, filename) => {
      // .env lives beside config.json; a secret rotation there must trigger a reload
      // too (readConfigFromDisk force-refreshes process.env as a side effect).
      if (filename) {
        const name = basename(filename.toString());
        if (name !== file && name !== ".env") return;
      }
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void reload(), debounceMs);
    });
  } catch (err) {
    void log("warn", "config watcher could not start", { error: String(err) });
  }

  return {
    stop: () => {
      if (timer) clearTimeout(timer);
      if (confirmTimer) clearTimeout(confirmTimer);
      watcher?.close();
    },
    // Exposed so `/config rollback` applies through this exact path: a restored dotfile emits no
    // fs.watch event, so waiting for the watcher would apply nothing and report nothing.
    reloadNow: reload,
  };
}
