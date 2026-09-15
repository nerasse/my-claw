import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { MY_CLAW_DIR } from "../../core/config.ts";
import { writeJsonFileAtomically } from "../../utils/atomic-write.ts";
import { log } from "../../utils/logger.ts";

/**
 * The folders the owner files conversations into, per owner.
 *
 * A folder is a place, not a property: a conversation carries a `folderId` and lives in exactly
 * one, which is why the store holds names and ranks and nothing about the conversations. Moving
 * one is a write on its own meta, deleting a folder is a `folderId` cleared on each child, and
 * neither can duplicate or lose a conversation -- docs/session-folders.md.
 *
 * Server-side, exactly like the pinned list it replaces: the owner files a conversation once and
 * finds it there from the phone and from the browser alike. Kept per device it would be a cache,
 * and a cache of a filing cabinet is a filing cabinet that disagrees with itself.
 *
 * Written on every mutation and awaited, unlike the draft store: a folder changes on a deliberate
 * gesture, and losing the name of one to a debounced write at shutdown is not a trade worth making
 * for a handful of writes a week.
 */

/** Longest folder name. The drawer draws it on one line; past this it would be cut anyway. */
export const FOLDER_NAME_LIMIT = 60;

/** Past this, the store refuses rather than rotating: a filing cabinet nobody can read is not one. */
export const MAX_FOLDERS = 200;

export interface Folder {
  id: string;
  name: string;
  /** Dense, from 0. The order of the drawer's sections. */
  rank: number;
  /**
   * The workspace the folder was born in. It is not a scope: a folder holds conversations from
   * anywhere. It defaults the workspace of a conversation created from inside the folder, and it
   * is what keeps an empty folder visible under a workspace filter.
   */
  workspace?: string;
}

interface FolderFile {
  version: 1;
  owners: Record<string, Folder[]>;
}

export class FolderStore {
  private owners = new Map<string, Folder[]>();
  private loaded?: Promise<void>;
  private readonly path: string;

  constructor(path?: string) {
    this.path = path ?? join(MY_CLAW_DIR, "my-claw-app", "folders.json");
  }

  /** The owner's folders, in rank order. */
  async list(owner: string): Promise<Folder[]> {
    await this.ready();
    return [...(this.owners.get(owner) ?? [])];
  }

  /**
   * Adds a folder at the end of the owner's list.
   *
   * Appending, like the pinned list appended: a folder that landed on top would push the ones the
   * owner reads by position down the panel without being asked.
   */
  async create(owner: string, name: string, workspace?: string): Promise<Folder> {
    await this.ready();
    const folders = this.owners.get(owner) ?? [];
    const clean = checkName(name);
    refuseDuplicate(folders, clean, null);
    if (folders.length >= MAX_FOLDERS) throw new Error(`at most ${MAX_FOLDERS} folders`);
    const folder: Folder = {
      id: randomUUID(),
      name: clean,
      rank: folders.length,
      ...(workspace ? { workspace } : {}),
    };
    this.owners.set(owner, [...folders, folder]);
    await this.persist();
    return folder;
  }

  /** Same-name check included: renaming onto another folder's name is refused, not merged. */
  async rename(owner: string, id: string, name: string): Promise<void> {
    await this.ready();
    const folders = this.owners.get(owner) ?? [];
    const folder = folders.find((entry) => entry.id === id);
    if (!folder) throw new Error("folder not found");
    const clean = checkName(name);
    refuseDuplicate(folders, clean, id);
    if (folder.name === clean) return;
    folder.name = clean;
    await this.persist();
  }

  /**
   * Drops the folder. Answers whether it was there.
   *
   * The children are not touched here: clearing their `folderId` is a write on each of their meta
   * files, which is the session store's business. Left to the caller, a folder never disappears
   * with conversations still pointing at it -- and the ranks are renumbered here so the next
   * folder does not inherit the hole.
   */
  async remove(owner: string, id: string): Promise<boolean> {
    await this.ready();
    const folders = this.owners.get(owner) ?? [];
    const left = folders.filter((entry) => entry.id !== id);
    if (left.length === folders.length) return false;
    this.owners.set(owner, renumber(left));
    await this.persist();
    return true;
  }

  /**
   * Rewrites the order the owner dragged. Ids the owner cannot see are not touched: a folder
   * created on another device while this list was on screen keeps its place and lands after the
   * dragged ones, because a drop is a statement about what was dragged and nothing about the rest.
   */
  async reorder(owner: string, ids: string[]): Promise<void> {
    await this.ready();
    const folders = this.owners.get(owner) ?? [];
    const byId = new Map(folders.map((folder) => [folder.id, folder]));
    const head: Folder[] = [];
    for (const id of ids) {
      const folder = byId.get(id);
      if (!folder || head.includes(folder)) continue;
      head.push(folder);
    }
    const tail = folders.filter((folder) => !head.includes(folder));
    this.owners.set(owner, dense([...head, ...tail]));
    await this.persist();
  }

  private persist(): Promise<void> {
    const payload: FolderFile = { version: 1, owners: Object.fromEntries(this.owners) };
    return writeJsonFileAtomically(this.path, payload).catch((err) => {
      void log("error", "folder store write failed", { error: String(err) });
    });
  }

  private ready(): Promise<void> {
    this.loaded ??= this.load();
    return this.loaded;
  }

  /** One read at boot. An unreadable file is an empty store, never a boot that fails. */
  private async load(): Promise<void> {
    let parsed: FolderFile;
    try {
      parsed = JSON.parse(await readFile(this.path, "utf-8")) as FolderFile;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== "ENOENT") void log("warn", "folder store unreadable, starting empty", { error: String(err) });
      return;
    }
    if (!parsed || typeof parsed !== "object" || typeof parsed.owners !== "object") return;
    for (const [owner, folders] of Object.entries(parsed.owners)) {
      if (!Array.isArray(folders)) continue;
      const kept = folders.filter(
        (folder): folder is Folder =>
          typeof folder?.id === "string" && typeof folder.name === "string" && folder.name.trim() !== "",
      );
      if (kept.length === 0) continue;
      this.owners.set(owner, renumber(kept.map((folder) => ({ ...folder, rank: rankOf(folder) }))));
    }
  }
}

function rankOf(folder: Folder): number {
  return typeof folder.rank === "number" && Number.isFinite(folder.rank) ? folder.rank : Number.MAX_SAFE_INTEGER;
}

/** Sorts by rank and hands out dense ones, so a hole never survives a write. */
function renumber(folders: Folder[]): Folder[] {
  return dense([...folders].sort((left, right) => rankOf(left) - rankOf(right)));
}

/**
 * Hands out dense ranks in the order given, without reordering anything: the caller either sorted
 * by rank already or is stating the order it wants, and sorting again would undo a reorder.
 */
function dense(folders: Folder[]): Folder[] {
  return folders.map((folder, rank) => ({ ...folder, rank }));
}

function checkName(name: string): string {
  const clean = name.trim();
  if (!clean) throw new Error("a folder needs a name");
  if (clean.length > FOLDER_NAME_LIMIT) throw new Error(`folder names stop at ${FOLDER_NAME_LIMIT} characters`);
  return clean;
}

/** Case-insensitive: two folders the owner cannot tell apart are one folder he cannot tell apart. */
function refuseDuplicate(folders: Folder[], name: string, exceptId: string | null): void {
  const taken = folders.some(
    (folder) => folder.id !== exceptId && folder.name.toLowerCase() === name.toLowerCase(),
  );
  if (taken) throw new Error(`a folder named "${name}" already exists`);
}
