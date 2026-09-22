import { test } from "bun:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { workspaceNameForDir, type MyClawConfig } from "../../src/core/config.ts";
import { usageFolderOf, usageWorkspaceOf, type SessionData } from "../../src/sessions/store.ts";

/**
 * How one call is filed: its workspace and its folder, both read at call time.
 *
 * The owner, 2026-09-22: "il faut traquer les requetes depuis quel workspace [...] si ca existe
 * pas ajoute le" and "un filtre par dossier [...] un snapshot par appel". A conversation switches
 * workspace and gets re-filed, so the row carries what was true when the call ran and nothing
 * later rewrites it. docs/stats-page.md.
 */

const DEFAULT_DIR = join(tmpdir(), "usage-attribution-default");
const config = {
  workspace: DEFAULT_DIR,
  workspaces: {
    dev: "/home/me/dev",
    cf: "/home/me/dev/cf",
    career: "/home/me/career",
  },
} as unknown as MyClawConfig;

function session(over: Partial<SessionData> = {}, meta?: SessionData["meta"]): SessionData {
  return {
    id: over.id ?? "chat-1",
    platform: "my-claw-app",
    chatType: "dm",
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    ...over,
    ...(meta ? { meta } : {}),
  } as SessionData;
}

test("a directory is counted under its workspace, its tree included", () => {
  assert.equal(workspaceNameForDir(config, "/home/me/dev"), "dev");
  assert.equal(workspaceNameForDir(config, "/home/me/career"), "career");
  assert.equal(workspaceNameForDir(config, DEFAULT_DIR), "default");
  // Inside a workspace's tree is that workspace's work: a sub-agent pinned to a repo directory
  // must not be counted as "default", which is what a strict key match would say.
  assert.equal(workspaceNameForDir(config, "/home/me/dev/my-claw"), "dev");
  // Longest root wins, so a nested workspace is never swallowed by the one around it.
  assert.equal(workspaceNameForDir(config, "/home/me/dev/cf/src"), "cf");
  // And a directory that belongs to none of them is named as what it is.
  assert.equal(workspaceNameForDir(config, "/srv/elsewhere"), "/srv/elsewhere");
});

test("the workspace of a call is where the run works, key named", () => {
  // A sub-agent carries the directory it was spawned into, which is the truth for its runs.
  assert.equal(usageWorkspaceOf(config, session({}, { workspaceDir: "/home/me/dev/my-claw" } as SessionData["meta"])), "dev");
  // Any other session runs in its workspace key's directory.
  assert.equal(usageWorkspaceOf(config, session({ workspace: "career" })), "career");
  assert.equal(usageWorkspaceOf(config, session({})), "default");
});

test("a call is filed as its payer's folder, and the payer's is its own live one", () => {
  // The payer: its own folder, read live -- a filing gesture mid-run applies to the calls after it.
  const payer = session({ id: "chat-1", folderId: "folder-career" });
  assert.equal(usageFolderOf(payer), "folder-career");

  // A delegated run: the folder the drive that started the work saw, stamped by the runner beside
  // `invokedBy`. Its own `folderId` is always empty -- a worker is not a conversation of the drawer.
  const worker = session(
    {
      id: "subagent/run-1",
      parentFolderId: "folder-dev",
      invokedBy: "chat-1",
    },
    { parentSessionId: "chat-1" } as SessionData["meta"],
  );
  assert.equal(usageFolderOf(worker), "folder-dev");

  // Even a worker carrying its own folder field is filed as its payer's: its calls are paid for by
  // the conversation that drove it, and that is the only filing the drawer can account for.
  const filedWorker = session(
    { id: "subagent/run-2", folderId: "folder-mine", parentFolderId: "folder-dev", invokedBy: "chat-1" },
    { parentSessionId: "chat-1" } as SessionData["meta"],
  );
  assert.equal(usageFolderOf(filedWorker), "folder-dev");

  // An unfiled conversation records no folder, which is the "(none)" of the filter, not an error.
  assert.equal(usageFolderOf(session({ id: "chat-2" })), undefined);
});
