import { watch, type FSWatcher } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { hooks } from "../hooks/index.ts";
import { log } from "../utils/logger.ts";
import type { SkillRegistry } from "./registry.ts";
import { reloadSkills, editableTierDirs, type SkillDirs } from "./reload.ts";

const DEBOUNCE_MS = 300;

export interface SkillsWatcherOptions {
  debounceMs?: number;
  // Test seam: override the rescan so tests can assert without touching real dirs.
  reload?: () => Promise<number>;
  // Tier dirs may change at runtime (config.workspaces is hot-reloadable): re-derived on
  // every event so a newly added workspace is picked up without a restart.
  getTierDirs?: () => string[];
}

/**
 * Watch the editable skill tiers (custom + workspace) and refresh the registry on
 * change, so a dropped or edited SKILL.md is live on the next run without a restart.
 *
 * Bun's recursive fs.watch is unreliable on Linux (only top-level events fire), and
 * skills live one level deep (<dir>/<skill>/SKILL.md). So this watches each tier dir
 * (catches skill add/remove) AND every skill subdir (catches SKILL.md edits),
 * re-syncing the subdir watchers whenever the tier structure changes. The built-in
 * tier is intentionally not watched: it is repo-synced at boot only.
 */
export function startSkillsWatcher(
  dirs: SkillDirs,
  registry: SkillRegistry,
  options: SkillsWatcherOptions = {},
): () => void {
  const debounceMs = options.debounceMs ?? DEBOUNCE_MS;
  const reload = options.reload ?? (() => reloadSkills(dirs, registry));
  const getTierDirs = options.getTierDirs ?? (() => editableTierDirs(dirs));

  let timer: ReturnType<typeof setTimeout> | undefined;
  const tierWatchers = new Map<string, FSWatcher>();
  const childWatchers = new Map<string, FSWatcher>();
  let stopped = false;

  const scheduleReload = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      void reload()
        .then((count) => {
          hooks.emit("skills:reloaded", { count });
          void log("info", "skills reloaded from disk", { count });
        })
        .catch((err) => void log("error", "skills reload failed", { error: String(err) }));
    }, debounceMs);
  };

  // (Re)attach a watcher to every skill subdir of the tier dirs. Called on start and
  // whenever a tier fires, since a new skill dir needs its own watcher to catch edits.
  const syncChildWatchers = async (): Promise<void> => {
    if (stopped) return;
    const present = new Set<string>();
    for (const tier of getTierDirs()) {
      let entries;
      try {
        entries = await readdir(tier, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
        const skillDir = join(tier, entry.name);
        present.add(skillDir);
        if (childWatchers.has(skillDir)) continue;
        try {
          childWatchers.set(skillDir, watch(skillDir, () => scheduleReload()));
        } catch {
          // Skill dir vanished between readdir and watch; the next sync drops it.
        }
      }
    }
    for (const [dir, w] of childWatchers) {
      if (!present.has(dir)) {
        w.close();
        childWatchers.delete(dir);
      }
    }
  };

  const onTierEvent = (): void => {
    // A new tier dir (config.workspaces edited) gets its own watcher before the rescan.
    syncTierWatchers();
    void syncChildWatchers();
    scheduleReload();
  };

  /** Attach watchers to tier dirs that appeared since the last event (hot workspaces). */
  const syncTierWatchers = (): void => {
    for (const tier of getTierDirs()) {
      if (tierWatchers.has(tier)) continue;
      void mkdir(tier, { recursive: true }).catch(() => undefined);
      try {
        tierWatchers.set(tier, watch(tier, () => onTierEvent()));
      } catch {
        // Race with mkdir: the next event retries.
      }
    }
  };

  void (async () => {
    for (const tier of getTierDirs()) {
      // Watching a missing dir throws; create it so a later mkdir by the agent is seen.
      await mkdir(tier, { recursive: true }).catch(() => undefined);
      if (stopped) return;
      try {
        tierWatchers.set(tier, watch(tier, () => onTierEvent()));
      } catch (err) {
        void log("warn", "skills watcher could not watch tier", { dir: tier, error: String(err) });
      }
    }
    await syncChildWatchers();
  })();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    for (const w of tierWatchers.values()) w.close();
    for (const w of childWatchers.values()) w.close();
    tierWatchers.clear();
    childWatchers.clear();
  };
}
