// The download registry: a file is secured the moment Chromium starts downloading it.
//
// WHY immediately, and not when the agent asks: Playwright parks a download's bytes in a temp
// file that dies with the page. An agent clicks a link and only then asks for the file, and in
// between a tab that closes itself (a file.php endpoint, a blob:, a redirect) takes the download
// with it. Measured over 1631 runs (2026-10-27): 155 of 511 download calls failed, 22 of them
// with "download.saveAs: canceled", and 522 browser_eval calls existed only to work around it.
//
// The names come from the page, so nothing here trusts them: the staged path is built from our
// own id, and the final name is sanitised, shortened and resolved inside the destination.
import { copyFile, mkdir, open, readdir, rename, stat, unlink } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

/** Where downloads wait between the browser's event and the agent's claim. */
export const STAGING = process.env.DOWNLOADS_STAGING_DIR || join(tmpdir(), "my-claw-downloads");
const INCOMING = join(STAGING, ".incoming");

/** Long enough for any sane file name, short enough for the 255-byte limit of every filesystem
 *  this runs on. Truncation keeps the extension, which is what tells a caller what it got. */
const MAX_NAME_BYTES = 150;

const records = new Map(); // id -> record
let nextId = 1;

/**
 * A record.
 * @typedef {object} DownloadRecord
 * @property {number} id
 * @property {string} pageId
 * @property {number|undefined} windowId
 * @property {string} suggested  the page's own name, unsanitised
 * @property {string} url
 * @property {string} stagePath
 * @property {"saving"|"ready"|"failed"} state
 * @property {string|undefined} error
 * @property {number|undefined} bytes
 * @property {string|undefined} kind   sniffed from the first bytes, never from the name
 * @property {number} createdAt
 * @property {string|undefined} claimedInto
 */

let prepared = null;

/** A directory that exists, and leftovers of a previous process swept once. */
function ensureStaging() {
  prepared ??= (async () => {
    await mkdir(INCOMING, { recursive: true });
    // A restart loses the records of the files still staged: they are unreachable, so they go.
    const stale = await readdir(INCOMING).catch(() => []);
    await Promise.all(stale.map((name) => unlink(join(INCOMING, name)).catch(() => undefined)));
  })();
  return prepared;
}

/**
 * A file name that is safe to join to a directory: no separators, no control characters, no
 * leading dots, and short enough in BYTES (a 300-character name from a Content-Disposition is
 * what produced the first ENAMETOOLONG).
 */
export function safeFileName(raw) {
  const last = String(raw ?? "").split(/[\\/]/).pop() ?? "";
  let name = last
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[.\s]+/, "");
  if (name === "") return "download";
  const ext = extname(name);
  let stem = ext && ext !== name ? name.slice(0, -ext.length) : name;
  let suffix = ext && ext !== name ? ext : "";
  const room = MAX_NAME_BYTES - Buffer.byteLength(suffix);
  while (Buffer.byteLength(stem) > room && stem.length > 0) stem = stem.slice(0, -1);
  stem = stem.trim();
  if (stem === "") stem = "download";
  return stem + suffix;
}

/** `dir/name`, then `dir/name (2)`, `dir/name (3)`: a second download never overwrites the first. */
async function uniquePath(dir, name) {
  const ext = extname(name);
  const stem = ext && ext !== name ? name.slice(0, -ext.length) : name;
  const suffix = ext && ext !== name ? ext : "";
  for (let i = 1; i < 1000; i++) {
    const candidate = i === 1 ? name : `${stem} (${i})${suffix}`;
    const path = join(dir, candidate);
    try {
      await stat(path);
    } catch {
      return { path, filename: candidate };
    }
  }
  return { path: join(dir, `${stem} (${Date.now()})${suffix}`), filename: `${stem} (${Date.now()})${suffix}` };
}

const KINDS = [
  [/^%PDF-/, "pdf"],
  [/^PK\x03\x04/, "zip"],
  [/^\x89PNG\r?\n/, "png"],
  [/^\xff\xd8\xff/, "jpeg"],
  [/^GIF8/, "gif"],
  [/^%!PS/, "postscript"],
  [/^\x1f\x8b/, "gzip"],
  [/^(<!doctype html|<html|<head|<body)/i, "html"],
];

/** What the file actually is, from its first bytes. A site that answers a PDF link with an HTML
 *  error page is the single most common way an agent reports a download it does not have. */
async function sniff(path) {
  let handle;
  try {
    handle = await open(path, "r");
    const buffer = Buffer.alloc(24);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const head = buffer.subarray(0, bytesRead).toString("latin1");
    for (const [pattern, kind] of KINDS) if (pattern.test(head)) return kind;
    return "unknown";
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Takes a Playwright download the instant Chromium reports it, and holds its bytes. Never throws
 * to the event loop: a failed save is recorded and reported by `claim`, which is where an agent
 * is waiting to hear about it.
 */
export async function registerDownload(download, pageId, windowId) {
  await ensureStaging();
  const id = nextId++;
  const stagePath = join(INCOMING, `${id}-${Date.now()}`);
  /** @type {DownloadRecord} */
  const record = {
    id,
    pageId,
    windowId: undefined,
    suggested: "",
    url: "",
    stagePath,
    state: "saving",
    createdAt: Date.now(),
  };
  record.windowId = typeof windowId === "number" ? windowId : undefined;
  records.set(id, record);
  try {
    record.suggested = download.suggestedFilename();
    record.url = download.url();
  } catch {
    record.suggested = "download";
  }
  void download
    .saveAs(stagePath)
    .then(async () => {
      const info = await stat(stagePath).catch(() => undefined);
      record.bytes = info?.size;
      record.kind = await sniff(stagePath);
      record.state = "ready";
    })
    .catch((e) => {
      record.state = "failed";
      record.error = String(e instanceof Error ? e.message : e);
    });
  return id;
}

/** The records of one page or one window, oldest first. */
export function listDownloads({ pageId, windowId } = {}) {
  return [...records.values()].filter((r) => matches(r, { pageId, windowId })).sort((a, b) => a.createdAt - b.createdAt).map(view);
}

function matches(record, { pageId, windowId }) {
  if (pageId === undefined && windowId === undefined) return true;
  // Either address matches: a download started from a popup is the window's, and one whose
  // window could not be read is still the page's. Losing a record to a strict conjunction is
  // exactly how an agent ends up downloading the same file twice.
  return (pageId !== undefined && record.pageId === pageId) || (windowId !== undefined && record.windowId === windowId);
}

function view(record) {
  return {
    id: record.id,
    pageId: record.pageId,
    windowId: record.windowId,
    suggested: record.suggested,
    url: record.url,
    state: record.state,
    error: record.error,
    bytes: record.bytes,
    kind: record.kind,
    createdAt: record.createdAt,
    claimedInto: record.claimedInto,
  };
}

/** Records nobody has taken yet, oldest first: what a `browser_download` with no id means. */
export function unclaimed(scope = {}) {
  return [...records.values()]
    .filter((r) => r.claimedInto === undefined && matches(r, scope))
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** A record id that is still known, for a claim that names one. */
export function recordOf(id) {
  return records.get(Number(id));
}

async function waitReady(record, deadline) {
  while (record.state === "saving" && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (record.state === "failed") {
    throw new Error(`The download failed before it could be saved: ${record.error}`);
  }
  if (record.state !== "ready") {
    throw new Error(`The download is still running (${record.suggested || "unnamed"}). Give it more time.`);
  }
}

/**
 * Moves a staged download to its final name and returns what it is. `dir` is absolute and chosen
 * by the caller (the Bun side, which knows the workspace); the name may come from the page, so it
 * is sanitised here and the result is proven to be inside `dir` before anything is written.
 */
export async function claimDownload({
  id,
  pageId,
  windowId,
  dir,
  filename,
  overwrite = false,
  waitMs = 0,
  pageCanStillDownload = true,
}) {
  await ensureStaging();
  if (!dir || !dir.startsWith("/")) throw new Error("claim needs an absolute directory");
  const deadline = Date.now() + Math.max(0, Number(waitMs) || 0);
  let record = id !== undefined ? recordOf(id) : unclaimed({ pageId, windowId }).at(0);
  // A tab that is gone cannot start a new download: waiting for one would be waiting for nothing,
  // which is what made a stale page id burn the whole timeout (measured: 155 failed calls,
  // 73 minutes of it). The records already taken survive it, so those are still claimable.
  while (!record && pageCanStillDownload && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150));
    record = id !== undefined ? recordOf(id) : unclaimed({ pageId, windowId }).at(0);
  }
  if (!record) {
    throw new Error(
      pageCanStillDownload
        ? "No download to save. Trigger the download first (click the link), or check browser_downloads."
        : "No download to save: that tab is closed, so it cannot start one.",
    );
  }
  await waitReady(record, deadline || Date.now() + 2000);

  const name = safeFileName(filename ?? record.suggested);
  await mkdir(dir, { recursive: true });
  const target = overwrite ? { path: join(dir, name), filename: name } : await uniquePath(dir, name);
  const base = resolve(dir) + sep;
  if (!resolve(target.path).startsWith(base)) {
    throw new Error(`Refusing to write outside the download directory: ${target.path}`);
  }
  try {
    await rename(record.stagePath, target.path);
  } catch (e) {
    if (e?.code !== "EXDEV") throw e;
    await copyFile(record.stagePath, target.path);
    await unlink(record.stagePath).catch(() => undefined);
  }
  record.claimedInto = target.path;
  const info = await stat(target.path).catch(() => undefined);
  return {
    id: record.id,
    path: target.path,
    filename: target.filename,
    bytes: info?.size ?? record.bytes ?? 0,
    kind: record.kind ?? (await sniff(target.path)),
    url: record.url,
    suggested: record.suggested,
  };
}
