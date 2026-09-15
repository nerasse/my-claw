/**
 * The media-id sweep, by hand -- docs/attachments.md.
 *
 * The boot pass does this on its own, once, and stamps the tree when it is done. This script is
 * what reads the numbers before that happens: how many markers name a picture, how many of those
 * find their copy, and which names are holes nothing can serve. A hole is not a failure of the
 * pass: it is a picture the store never received, and the display says so instead of drawing blank.
 *
 * Nothing is written unless `--apply` is given, and that refuses to run while the server holds the
 * logs: an append from a live run would land in a file this pass replaces, and the entry would be
 * lost. Restart the server instead -- the pass at boot does the same work in the window where
 * nothing has a session open yet.
 *
 *   bun run scripts/migrate-media-ids.ts                 # report only
 *   bun run scripts/migrate-media-ids.ts --apply         # server stopped
 */

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { writeFileAtomically } from "../src/utils/atomic-write.ts";
import {
  FILES_DIR,
  STAMP_FILE,
  owners,
  ownerThreadDirs,
  ownerOfSessionId,
  sessionDirs,
  migrateMediaIdsForSession,
  SESSIONS_DIR,
  type MediaScope,
} from "../src/sessions/migrate-media-ids.ts";

const args = process.argv.slice(2);
const apply = args.includes("--apply");

function serverRunning(): boolean {
  const unit = spawnSync("systemctl", ["--user", "is-active", "my-claw.service"], {
    encoding: "utf-8",
  });
  return unit.stdout?.trim() === "active";
}

if (apply && serverRunning()) {
  console.error("my-claw is running: restart it and let the boot pass rewrite the logs, or stop it first.");
  process.exit(1);
}

const allOwners = await owners();
const trees = new Map<string, string[]>();
const treeOf = async (owner: string): Promise<string[]> => {
  const cached = trees.get(owner);
  if (cached) return cached;
  const dirs = await ownerThreadDirs(owner);
  trees.set(owner, dirs);
  return dirs;
};

let sessions = 0;
let markers = 0;
let paired = 0;
let holes = 0;
const missing = new Set<string>();
let failed = 0;

for (const dir of await sessionDirs()) {
  const sessionId = dir.slice(SESSIONS_DIR.length + 1).replace(/\\/g, "/");
  const owner = ownerOfSessionId(sessionId);
  const thread = sessionId.split("/").pop() ?? "";
  const scopes: MediaScope = owner
    ? { own: [join(FILES_DIR, owner, thread)], fallback: await treeOf(owner) }
    : { own: [], fallback: (await Promise.all(allOwners.map(treeOf))).flat() };
  try {
    const report = await migrateMediaIdsForSession(sessionId, scopes, !apply);
    if (!report) continue;
    sessions += 1;
    markers += report.markers;
    paired += report.paired;
    holes += report.holes;
    for (const name of report.missing) missing.add(name);
  } catch (err) {
    failed += 1;
    console.error(`left as is: ${sessionId}: ${String(err)}`);
  }
}

// A hand sweep that succeeded is a complete one: stamp it, so the next boot does not re-read
// every log to find nothing to do.
if (apply && failed === 0) await writeFileAtomically(STAMP_FILE, `${new Date().toISOString()}\n`);

console.log(
  JSON.stringify(
    {
      mode: apply ? "apply" : "dry-run",
      fileRoot: FILES_DIR,
      sessions,
      markers,
      paired,
      holes,
      failed,
      missing: [...missing].sort(),
    },
    null,
    2,
  ),
);
