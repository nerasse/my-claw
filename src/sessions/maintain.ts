/**
 * The pass that gives every conversation an index, and heals the ones carrying damage.
 *
 * `openSessionLog` reads the byte map of a log, and builds it when there is none -- once, for a
 * conversation nobody has opened since the index existed. That build is cheap (a scan of the file
 * that extracts four fields per line instead of parsing entries), but an install with three hundred
 * conversations should not pay it on the first open of each. This walks them at boot, one at a
 * time, behind everything else the process is doing.
 *
 * It is also where `branches.ts` runs. The repair needs every entry, and a reader must never pay
 * for it twice: a session that was checked is marked in its meta, and `openSessionLog` skips the
 * question from then on. An install upgrading from a version that wrote dead branches heals itself
 * here, in the background, without anyone opening anything.
 *
 * Never touches a conversation that a run is using, and never opens the manager's cache: the logs
 * it opens are its own and go away with the pass. A process killed mid-pass costs the work of the
 * sessions not reached yet, whose index -- or whose meta flag -- is simply built next time.
 */

import { stat } from "node:fs/promises";
import { listSessionIdsByPrefix } from "./store.ts";
import { openSessionLog, entriesPath } from "./log.ts";
import { readMeta, writeMeta } from "./meta.ts";
import { log } from "../utils/logger.ts";

export interface MaintenanceReport {
  scanned: number;
  repaired: number;
  checked: number;
  failed: number;
}

export interface MaintenanceOptions {
  /** A conversation a run is using right now: its log is somebody else's to write. */
  isBusy?: (sessionId: string) => boolean;
  /** How long the pass may spend, in milliseconds. Whatever is left is done on the next boot. */
  budgetMs?: number;
  /** Yield to the event loop between conversations, so a boot never stalls on this. */
  onProgress?: (done: number, total: number) => void;
}

export async function maintainSessions(options: MaintenanceOptions = {}): Promise<MaintenanceReport> {
  const report: MaintenanceReport = { scanned: 0, repaired: 0, checked: 0, failed: 0 };
  const started = Date.now();
  const budget = options.budgetMs ?? 10 * 60 * 1000;
  const ids = await listSessionIdsByPrefix("", Number.MAX_SAFE_INTEGER).catch(() => [] as string[]);
  for (const sessionId of ids) {
    if (Date.now() - started > budget) break;
    if (options.isBusy?.(sessionId)) continue;
    try {
      // A session with no log of its own (a conversation that never wrote) costs one stat.
      const meta = await readMeta(sessionId).catch(() => null);
      report.scanned += 1;
      const size = await stat(entriesPath(sessionId)).then((info) => info.size, () => 0);
      if (size === 0) continue;
      const opened = await openSessionLog(sessionId, meta?.leafId ?? null, meta?.branchesChecked === true);
      if (opened.repaired) report.repaired += 1;
      if (meta && (!meta.branchesChecked || (opened.repaired?.adoptedTail && meta.leafId !== opened.leaf()))) {
        await writeMeta(sessionId, { ...meta, leafId: opened.leaf(), branchesChecked: true });
        report.checked += 1;
      }
      await opened.flush();
    } catch (err) {
      report.failed += 1;
      void log("warn", "session maintenance: a conversation was skipped", { sessionId, error: String(err) });
    }
    options.onProgress?.(report.scanned, ids.length);
    // Give the loop back: this runs alongside the first messages of the day.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return report;
}
