import type { ServerWebSocket } from "bun";
import { dirname, resolve } from "node:path";
import { briefError } from "../../utils/errors.ts";
import { myClawAppLog } from "../../utils/logger.ts";
import { sanitizeThreadId } from "./sessions.ts";
import {
  fsRemoveRefusal,
  listDirectory,
  makeDirectory,
  moveEntry,
  readFileWindow,
  removeEntry,
  writeTextFile,
  type FsRemoveGuards,
  type FsWatchRegistry,
} from "./fs-ops.ts";
import type { MyClawAppFsProvider, MyClawAppSessionData } from "./controllers.ts";
import type { MyClawAppErrorScope, MyClawAppFsList, MyClawAppFsMkdir, MyClawAppFsMove, MyClawAppFsRead, MyClawAppFsRemove, MyClawAppFsSessionRoot, MyClawAppFsUnwatch, MyClawAppFsWatch, MyClawAppFsWrite, MyClawAppServerFrame } from "./types.ts";

/**
 * The files page's frame handlers -- docs/files-page.md.
 *
 * Same contract as the settings handlers: plain functions over one socket, the adapter's exits
 * arrive as deps, and the answers echo the path the request named. Read, write and listing errors
 * travel inside their result frame (the page shows a state, not a popup); everything that is an
 * instruction the server refused travels as a refusal, named.
 */
export interface MyClawAppFsDeps {
  sendFrame(ws: ServerWebSocket<MyClawAppSessionData> | undefined, frame: MyClawAppServerFrame): void;
  refuse(
    ws: ServerWebSocket<MyClawAppSessionData>,
    scope: MyClawAppErrorScope,
    message: string,
    data?: Record<string, unknown>,
  ): Promise<void>;
  /** The entry point's config-side answers; absent on a host that registered none. */
  fs?: MyClawAppFsProvider;
  /** The watchers open right now, keyed by socket. */
  watches: FsWatchRegistry;
}

const ENCODINGS = ["utf8", "utf8-bom", "latin1", "utf16le", "utf16be"] as const;
const EOLS = ["lf", "crlf", "mixed"] as const;

/** Absolute and normalised, exactly as the frame contract promises the app. */
function framePath(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  return resolve(raw);
}

function isCount(raw: unknown): raw is number {
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0;
}

export async function handleFsList(
  d: MyClawAppFsDeps,
  ws: ServerWebSocket<MyClawAppSessionData>,
  frame: MyClawAppFsList,
): Promise<void> {
  const path = framePath(frame.path);
  if (!path) {
    await d.refuse(ws, "fs", "fs.list without a path");
    return;
  }
  const parent = path === "/" ? null : dirname(path);
  try {
    const listing = await listDirectory(path);
    d.sendFrame(ws, { type: "fs.list.result", path, parent, entries: listing.entries, truncated: listing.truncated });
  } catch (err) {
    d.sendFrame(ws, { type: "fs.list.result", path, parent, entries: [], truncated: false, error: briefError(err) });
  }
}

export async function handleFsRead(
  d: MyClawAppFsDeps,
  ws: ServerWebSocket<MyClawAppSessionData>,
  frame: MyClawAppFsRead,
): Promise<void> {
  const path = framePath(frame.path);
  if (!path) {
    await d.refuse(ws, "fs", "fs.read without a path");
    return;
  }
  if (frame.from !== undefined && !isCount(frame.from)) {
    await d.refuse(ws, "fs", "invalid fs.read from", { path, from: frame.from });
    return;
  }
  if (frame.maxBytes !== undefined && !isCount(frame.maxBytes)) {
    await d.refuse(ws, "fs", "invalid fs.read maxBytes", { path, maxBytes: frame.maxBytes });
    return;
  }
  try {
    const window = await readFileWindow(path, frame.from, frame.maxBytes);
    d.sendFrame(ws, { type: "fs.read.result", path, ...window });
  } catch (err) {
    d.sendFrame(ws, { type: "fs.read.result", path, from: 0, nextFrom: null, truncated: false, error: briefError(err) });
  }
}

export async function handleFsWrite(
  d: MyClawAppFsDeps,
  ws: ServerWebSocket<MyClawAppSessionData>,
  frame: MyClawAppFsWrite,
): Promise<void> {
  const path = framePath(frame.path);
  if (!path) {
    await d.refuse(ws, "fs", "fs.write without a path");
    return;
  }
  if (typeof frame.text !== "string" || typeof frame.etag !== "string") {
    await d.refuse(ws, "fs", "fs.write needs text and etag", { path });
    return;
  }
  if (frame.force !== undefined && typeof frame.force !== "boolean") {
    await d.refuse(ws, "fs", "invalid fs.write force", { path });
    return;
  }
  if (frame.encoding !== undefined && !ENCODINGS.includes(frame.encoding)) {
    await d.refuse(ws, "fs", "invalid fs.write encoding", { path, encoding: frame.encoding });
    return;
  }
  if (frame.eol !== undefined && !EOLS.includes(frame.eol)) {
    await d.refuse(ws, "fs", "invalid fs.write eol", { path, eol: frame.eol });
    return;
  }
  try {
    const outcome = await writeTextFile({
      path,
      text: frame.text,
      etag: frame.etag,
      ...(frame.force !== undefined ? { force: frame.force } : {}),
      ...(frame.encoding !== undefined ? { encoding: frame.encoding } : {}),
      ...(frame.eol !== undefined ? { eol: frame.eol } : {}),
    });
    if (outcome.ok) {
      d.sendFrame(ws, { type: "fs.write.result", path, etag: outcome.etag, size: outcome.size, mtimeMs: outcome.mtimeMs });
      await myClawAppLog("info", "fs.write", { path, size: outcome.size, device: ws.data.deviceId });
    } else {
      d.sendFrame(ws, {
        type: "fs.write.result",
        path,
        etag: outcome.conflict.etag,
        size: outcome.conflict.size,
        mtimeMs: outcome.conflict.mtimeMs,
        conflict: outcome.conflict,
      });
      await myClawAppLog("warn", "fs.write conflict", { path, size: outcome.conflict.size, device: ws.data.deviceId });
    }
  } catch (err) {
    d.sendFrame(ws, { type: "fs.write.result", path, error: briefError(err) });
    await myClawAppLog("warn", "fs.write failed", { path, device: ws.data.deviceId, error: briefError(err) });
  }
}

export async function handleFsMkdir(
  d: MyClawAppFsDeps,
  ws: ServerWebSocket<MyClawAppSessionData>,
  frame: MyClawAppFsMkdir,
): Promise<void> {
  const path = framePath(frame.path);
  if (!path) {
    await d.refuse(ws, "fs", "fs.mkdir without a path");
    return;
  }
  try {
    await makeDirectory(path);
    d.sendFrame(ws, { type: "fs.mkdir.result", path });
  } catch (err) {
    await d.refuse(ws, "fs", "fs.mkdir failed", { path, error: briefError(err) });
  }
}

export async function handleFsMove(
  d: MyClawAppFsDeps,
  ws: ServerWebSocket<MyClawAppSessionData>,
  frame: MyClawAppFsMove,
): Promise<void> {
  const from = framePath(frame.from);
  const to = framePath(frame.to);
  if (!from || !to) {
    await d.refuse(ws, "fs", "fs.move needs from and to", { from: frame.from, to: frame.to });
    return;
  }
  try {
    await moveEntry(from, to);
    d.sendFrame(ws, { type: "fs.move.result", from, to });
  } catch (err) {
    await d.refuse(ws, "fs", "fs.move failed", { from, to, error: briefError(err) });
  }
}

export async function handleFsRemove(
  d: MyClawAppFsDeps,
  ws: ServerWebSocket<MyClawAppSessionData>,
  frame: MyClawAppFsRemove,
): Promise<void> {
  const path = framePath(frame.path);
  if (!path) {
    await d.refuse(ws, "fs", "fs.remove without a path");
    return;
  }
  if (frame.recursive !== undefined && typeof frame.recursive !== "boolean") {
    await d.refuse(ws, "fs", "invalid fs.remove recursive", { path });
    return;
  }
  if (!d.fs) {
    await d.refuse(ws, "fs", "files unavailable");
    return;
  }
  let guards: FsRemoveGuards;
  try {
    guards = d.fs.protectedRoots();
  } catch (err) {
    await d.refuse(ws, "fs", "fs.remove failed", { path, error: briefError(err) });
    return;
  }
  const reason = await fsRemoveRefusal(path, guards);
  if (reason) {
    await d.refuse(ws, "fs", reason, { path });
    return;
  }
  try {
    await removeEntry(path, frame.recursive === true);
    d.sendFrame(ws, { type: "fs.remove.result", path });
    await myClawAppLog("info", "fs.remove", { path, recursive: frame.recursive === true, device: ws.data.deviceId });
  } catch (err) {
    await d.refuse(ws, "fs", "fs.remove failed", { path, error: briefError(err) });
  }
}

export async function handleFsWatch(
  d: MyClawAppFsDeps,
  ws: ServerWebSocket<MyClawAppSessionData>,
  frame: MyClawAppFsWatch,
): Promise<void> {
  const path = framePath(frame.path);
  if (!path) {
    await d.refuse(ws, "fs", "fs.watch without a path");
    return;
  }
  const watching = d.watches.watch(ws, path, (change) => {
    d.sendFrame(ws, { type: "fs.changed", path, kind: change.kind, size: change.size, mtimeMs: change.mtimeMs });
  });
  if (!watching) {
    await myClawAppLog("warn", "fs.watch not attached", { path, device: ws.data.deviceId, open: d.watches.count(ws) });
  }
  d.sendFrame(ws, { type: "fs.watch.result", path, watching });
}

export async function handleFsUnwatch(
  d: MyClawAppFsDeps,
  ws: ServerWebSocket<MyClawAppSessionData>,
  frame: MyClawAppFsUnwatch,
): Promise<void> {
  const path = framePath(frame.path);
  if (!path) {
    await d.refuse(ws, "fs", "fs.unwatch without a path");
    return;
  }
  d.watches.unwatch(ws, path);
  d.sendFrame(ws, { type: "fs.watch.result", path, watching: false });
}

export async function handleFsSessionRoot(
  d: MyClawAppFsDeps,
  ws: ServerWebSocket<MyClawAppSessionData>,
  frame: MyClawAppFsSessionRoot,
): Promise<void> {
  const threadId = typeof frame.threadId === "string" ? sanitizeThreadId(frame.threadId) : null;
  if (!threadId) {
    await d.refuse(ws, "fs", "invalid threadId", { threadId: frame.threadId });
    return;
  }
  if (!d.fs) {
    await d.refuse(ws, "fs", "files unavailable");
    return;
  }
  try {
    const path = await d.fs.sessionRoot(ws.data.owner, threadId);
    d.sendFrame(ws, { type: "fs.session.root.result", threadId, path });
  } catch (err) {
    await d.refuse(ws, "fs", "fs.session.root failed", { threadId, error: briefError(err) });
  }
}
