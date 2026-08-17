import { type FSWatcher } from "node:fs";
import { watchQuiet } from "../utils/watch.ts";
import { mkdir } from "node:fs/promises";
import { hooks } from "../hooks/index.ts";
import { log } from "../utils/logger.ts";
import type { AgentRegistry } from "./registry.ts";
import { reloadAgents, editableAgentTierDirs, type AgentDirs } from "./reload.ts";

const DEBOUNCE_MS = 300;

export interface AgentsWatcherOptions {
  debounceMs?: number;
  /** Test seam: override the rescan so tests can assert without touching real dirs. */
  reload?: () => Promise<number>;
  /** Re-derived on every event so a workspace added to a hot-reloaded config is picked up. */
  getTierDirs?: () => string[];
}

/**
 * Watch the editable agent tiers and refresh the registry on change.
 *
 * Unlike skills, this needs no second level of watchers: an agent is a file directly inside its
 * tier, so the tier watcher already sees both additions and edits. The built-in tier is not
 * watched, being repo-synced at boot.
 */
export function startAgentsWatcher(
  dirs: AgentDirs,
  registry: AgentRegistry,
  options: AgentsWatcherOptions = {},
): () => void {
  const debounceMs = options.debounceMs ?? DEBOUNCE_MS;
  const reload = options.reload ?? (() => reloadAgents(dirs, registry));
  const getTierDirs = options.getTierDirs ?? (() => editableAgentTierDirs(dirs));

  let timer: ReturnType<typeof setTimeout> | undefined;
  const tierWatchers = new Map<string, FSWatcher>();
  let stopped = false;

  const scheduleReload = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      void reload()
        .then((count) => {
          hooks.emit("agents:reloaded", { count });
          void log("info", "agents reloaded from disk", { count });
        })
        .catch((err) => void log("error", "agents reload failed", { error: String(err) }));
    }, debounceMs);
  };

  const onTierEvent = (): void => {
    // A tier dir that appeared since the last event (config.workspaces edited) gets its watcher
    // before the rescan, so the first change in a new workspace is not the one that is lost.
    syncTierWatchers();
    scheduleReload();
  };

  const syncTierWatchers = (): void => {
    if (stopped) return;
    for (const tier of getTierDirs()) {
      if (tierWatchers.has(tier)) continue;
      void mkdir(tier, { recursive: true }).catch(() => undefined);
      try {
        tierWatchers.set(tier, watchQuiet(tier, "agents tier", () => onTierEvent()));
      } catch {
        // Race with mkdir: the next event retries.
      }
    }
  };

  void (async () => {
    for (const tier of getTierDirs()) {
      // Watching a missing dir throws; create it so a later drop-in is seen.
      await mkdir(tier, { recursive: true }).catch(() => undefined);
      if (stopped) return;
      try {
        tierWatchers.set(tier, watchQuiet(tier, "agents tier", () => onTierEvent()));
      } catch (err) {
        void log("warn", "agents watcher could not watch tier", { dir: tier, error: String(err) });
      }
    }
  })();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    for (const w of tierWatchers.values()) w.close();
    tierWatchers.clear();
  };
}
