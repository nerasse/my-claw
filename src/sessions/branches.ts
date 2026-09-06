/**
 * Dead branches, put back on the branch when a log is opened.
 *
 * A session log is a tree: `parentId` links every entry to the one before it, and the meta's
 * leaf says which tip the conversation is on. Every entry the leaf does not reach is off the
 * branch: not in the prompt, not in the thread. Two things legitimately leave entries there, and
 * both leave a mark. A rewind command (`/undo`, `/retry`, `/redo`, `/fork`, `/branches`) writes
 * its own `command` entry at the position it moved to, so the fork point has a `command` child on
 * one side or the other. A run that died of an error rewinds to its own question and the channel
 * files a `failure` entry there, so the fork sits on a `user` entry with a `run_start` child whose
 * run ends in `error`, or with a `failure` child.
 *
 * Every other fork is damage. Until 0.6.1 one session could be held by two `SessionLog` instances
 * at once, each with its own leaf, and whatever the second one appended hung off a stale leaf:
 * everything the run had written past that leaf became a dead branch, still in the file, gone
 * from the thread and from the prompt. A process killed mid-run left the same shape, since the
 * leaf reached the meta only at the end of a run. Every install that ran 0.6.0 or earlier carries
 * some. Repairing at open is what makes the fix reach them without a step: the orphans go back in
 * file order (the order they happened in) between the fork point and the child that survived, and
 * a dead tail at the end of the file becomes the leaf. Nothing is deleted; only parent links move.
 *
 * `scripts/repair-branches.ts` runs the same function over every session, dry run by default.
 */

import type { Entry } from "./log.ts";

const BRANCH_COMMANDS = /^\/(undo|retry|redo|fork|branches?)\b/i;

export interface BranchRepair {
  /** File order kept. An entry whose parent moved is a copy; the others are the objects given. */
  entries: Entry[];
  leafId: string | null;
  /** Ids of the entries whose `parentId` changed. */
  relinked: string[];
  bugForks: number;
  deliberateForks: number;
  /** The leaf moved to a dead tail at the end of the file. */
  adoptedTail: boolean;
}

function pathOf(byId: Map<string, Entry>, leafId: string | null): Set<string> {
  const path = new Set<string>();
  let cur = leafId ? byId.get(leafId) : undefined;
  while (cur && !path.has(cur.id)) {
    path.add(cur.id);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return path;
}

/** Whether the chain from `head` (first child each time) is a run that ended in an error. */
function errorRun(head: Entry, children: Map<string, Entry[]>): boolean {
  if (head.type !== "run_start") return false;
  const seen = new Set<string>();
  let cur: Entry | undefined = head;
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    if (cur.type === "run_end") return cur.reason === "error";
    cur = children.get(cur.id)?.[0];
  }
  return false;
}

function isBranchCommand(entry: Entry | undefined): boolean {
  return entry?.type === "command" && BRANCH_COMMANDS.test(entry.input);
}

function descendants(root: Entry, children: Map<string, Entry[]>): Entry[] {
  const out: Entry[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    out.push(cur);
    for (const child of children.get(cur.id) ?? []) stack.push(child);
  }
  return out;
}

export function repairBranches(entries: readonly Entry[], leafId: string | null): BranchRepair {
  const list = [...entries];
  const byId = new Map(list.map((entry) => [entry.id, entry]));
  const index = new Map(list.map((entry, i) => [entry.id, i]));
  const children = new Map<string, Entry[]>();
  for (const entry of list) {
    if (!entry.parentId || !byId.has(entry.parentId)) continue;
    const siblings = children.get(entry.parentId) ?? [];
    siblings.push(entry);
    children.set(entry.parentId, siblings);
  }
  for (const siblings of children.values()) siblings.sort((a, b) => a.seq - b.seq);

  let leaf = leafId && byId.has(leafId) ? leafId : (list[list.length - 1]?.id ?? null);
  const report: BranchRepair = { entries: list, leafId: leaf, relinked: [], bugForks: 0, deliberateForks: 0, adoptedTail: false };
  if (list.length === 0) return report;
  let path = pathOf(byId, leaf);
  if (path.size === list.length) return report;

  // Fork points: on-path entries with an off-path child, oldest first. An off-path entry whose
  // parent is not in the log at all has nothing to be reattached to and is left where it is.
  const forks = new Map<string, Entry[]>();
  for (const entry of list) {
    if (path.has(entry.id) || !entry.parentId || !path.has(entry.parentId)) continue;
    const group = forks.get(entry.parentId) ?? [];
    group.push(entry);
    forks.set(entry.parentId, group);
  }
  const ordered = [...forks.entries()].sort(([a], [b]) => index.get(a)! - index.get(b)!);

  const relink = (entry: Entry, parentId: string): void => {
    const copy = { ...entry, parentId } as Entry;
    byId.set(entry.id, copy);
    list[index.get(entry.id)!] = copy;
    report.relinked.push(entry.id);
  };

  for (const [forkId, offChildren] of ordered) {
    const fork = byId.get(forkId)!;
    const siblings = children.get(forkId) ?? [];
    const survivor = siblings.find((child) => path.has(child.id));
    const deliberate =
      siblings.some(isBranchCommand) ||
      (fork.type === "user" && (survivor?.type === "failure" || offChildren.some((child) => errorRun(child, children))));
    if (deliberate) {
      report.deliberateForks += 1;
      continue;
    }
    report.bugForks += 1;
    const orphans = offChildren
      .flatMap((child) => descendants(child, children))
      .sort((a, b) => index.get(a.id)! - index.get(b.id)!);
    let prev = fork.id;
    for (const orphan of orphans) {
      if (orphan.parentId !== prev) relink(orphan, prev);
      prev = orphan.id;
    }
    if (survivor) relink(survivor, prev);
    else {
      leaf = prev;
      report.adoptedTail = true;
    }
    // The splice moved the branch: the forks after this one are judged against the new path.
    path = pathOf(byId, leaf);
  }

  report.leafId = leaf;
  return report;
}
