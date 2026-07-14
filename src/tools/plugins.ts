import { watch, type FSWatcher } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { log } from "../utils/logger.ts";
import { hooks } from "../hooks/index.ts";
import type { Tool, ToolResult } from "./types.ts";

const DEBOUNCE_MS = 300;
const MODULE_RE = /\.(ts|js|mjs)$/;

// Validate the data shape of an owner-authored plugin. `execute` is checked separately
// (Zod cannot reliably validate a function signature) and every call is isolated.
const PluginMetaSchema = z.object({
  name: z.string().min(1).max(64),
  description: z.string().min(1),
  parameters: z.record(z.string(), z.unknown()).optional(),
});

function coerceResult(res: unknown): ToolResult {
  if (res && typeof res === "object" && "success" in res && "output" in res) {
    return res as ToolResult;
  }
  return { success: true, output: typeof res === "string" ? res : JSON.stringify(res ?? "") };
}

/**
 * Loads owner-authored tool modules from an opt-in `tools.d/` directory at runtime.
 *
 * Off by default (config.tools.pluginsEnabled): running arbitrary code in-process is an
 * RCE surface. Guardrails: owner-only dir, Zod validation of the exported shape, a
 * collision check against built-in names, and try/catch isolation at both load and exec
 * so a broken plugin is skipped/logged and can never crash the process. Bun re-imports a
 * changed module via a cache-busting query string (verified on Bun 1.3.x).
 *
 * A module must export `tool` (preferred) or `default` as `{ name, description,
 * parameters?, execute(args) }`.
 */
export class PluginLoader {
  private tools: Tool[] = [];
  private watcher: FSWatcher | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly dir: string,
    private readonly reserved: Set<string>,
  ) {}

  async load(): Promise<number> {
    let entries;
    try {
      entries = await readdir(this.dir, { withFileTypes: true });
    } catch {
      this.tools = [];
      return 0;
    }
    const loaded: Tool[] = [];
    const seen = new Set<string>();
    for (const entry of entries) {
      if (!entry.isFile() || !MODULE_RE.test(entry.name)) continue;
      const tool = await this.loadOne(join(this.dir, entry.name));
      if (!tool) continue;
      if (seen.has(tool.name)) {
        void log("warn", "plugin tool name already loaded; skipping duplicate", { name: tool.name });
        continue;
      }
      seen.add(tool.name);
      loaded.push(tool);
    }
    this.tools = loaded;
    return loaded.length;
  }

  private async loadOne(path: string): Promise<Tool | undefined> {
    let mod: Record<string, unknown>;
    try {
      // Cache-bust so an edited plugin is re-read instead of served from the module cache.
      mod = (await import(`${path}?v=${Date.now()}`)) as Record<string, unknown>;
    } catch (err) {
      void log("warn", "plugin import failed", { path, error: String(err) });
      return undefined;
    }
    const candidate = (mod["tool"] ?? mod["default"]) as Record<string, unknown> | undefined;
    if (!candidate || typeof candidate !== "object") {
      void log("warn", "plugin has no `tool`/`default` export", { path });
      return undefined;
    }
    const meta = PluginMetaSchema.safeParse(candidate);
    if (!meta.success) {
      void log("warn", "plugin shape invalid", { path, error: meta.error.message });
      return undefined;
    }
    const exec = candidate["execute"];
    if (typeof exec !== "function") {
      void log("warn", "plugin `execute` is not a function", { path });
      return undefined;
    }
    if (this.reserved.has(meta.data.name)) {
      void log("warn", "plugin name collides with a built-in tool; skipping", { name: meta.data.name });
      return undefined;
    }
    const parameters = (meta.data.parameters ?? { type: "object", properties: {} }) as Record<string, unknown>;
    const run = exec as (args: Record<string, unknown>) => unknown;
    return {
      name: meta.data.name,
      description: meta.data.description,
      parameters,
      execute: async (args: Record<string, unknown>): Promise<ToolResult> => {
        try {
          return coerceResult(await run(args));
        } catch (err) {
          // Isolation: a throwing plugin becomes a failed tool result, never a process crash.
          return { success: false, output: "", error: `Plugin ${meta.data.name} threw: ${String(err)}` };
        }
      },
    };
  }

  getTools(): Tool[] {
    return this.tools;
  }

  async start(): Promise<void> {
    await mkdir(this.dir, { recursive: true }).catch(() => undefined);
    await this.load();
    // Files are flat in tools.d/, so a non-recursive watch sees edits/adds/removes directly.
    try {
      this.watcher = watch(this.dir, () => {
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
          void this.load()
            .then((count) => {
              hooks.emit("tools:pluginsReloaded", { count });
              void log("info", "tool plugins reloaded", { count });
            })
            .catch((err) => void log("error", "tool plugins reload failed", { error: String(err) }));
        }, DEBOUNCE_MS);
      });
    } catch (err) {
      void log("warn", "plugin watcher could not start", { dir: this.dir, error: String(err) });
    }
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.watcher?.close();
    this.watcher = undefined;
  }
}
