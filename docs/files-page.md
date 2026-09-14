# The files page: the whole machine, from the phone

The owner reads and edits the files of the machine my-claw runs on, from the app. Not the
workspace, not `$MY_CLAW_DIR`: `/`, minus nothing.

That is a deliberate extension of `docs/filesystem-access.md` rather than a new doctrine. The
agent already reaches anywhere its service user can, there is no containment check and the fence
was removed because `bash` crossed it anyway. A page that refused `/etc` while `read /etc/shadow`
succeeds in a chat bubble would teach the owner to distrust the page, not the boundary. So the
page has no jail either, and what protects the install is not a path allow-list: it is the
**etag contract** (nothing is overwritten under the reader's feet), **atomic writes** (a torn file
is never a state the disk was in) and a short list of paths that must never be *removed*.

## Decisions taken (2026-09-14)

| Question | Answer |
| --- | --- |
| Reach | The whole disk |
| Write | Everywhere, guarded by etag + atomic rename |
| Editor | CodeMirror 6 on both hosts (WebView on Android, direct in the browser) |
| Opened from a session | On that session's workspace directory |
| Noise | Nothing is hidden: `node_modules`, `.git`, `/proc` and `/sys` all list |
| Scope | navigate, read, edit, create, rename, move, delete, download, upload files, live tail |
| Start directory | The last one visited |

## The wire

Frames carry no request id. A result echoes the path it answers, exactly as `stats.result` echoes
its period: the app holds one page, and a listing for a directory the owner has already left is
dropped rather than drawn under the new one.

### `fs.list` → `fs.list.result`

```ts
{ type: "fs.list", path: string }
{ type: "fs.list.result", path: string, parent: string | null, entries: MyClawAppFsEntry[],
  truncated: boolean, error?: string }
```

- `path` is absolute and normalised by the server (`resolve()`), and the *response* carries the
  normalised path so the app can trust the breadcrumb it builds from it. `parent` is null at `/`.
- `entries` is in `readdir` order, unsorted: the app sorts (directories first, then name, and it
  may offer other orders later). Sorting in SQL-less JS twice is how a column ends up disagreeing
  with itself.
- `truncated` is true past `FS_LIST_LIMIT = 5000` entries. `node_modules` has more, and the page
  must say so rather than pretend.

```ts
interface MyClawAppFsEntry {
  name: string;
  path: string;
  kind: "file" | "dir" | "symlink" | "other";
  /** Resolved kind when `kind` is "symlink" and it resolves; absent otherwise. */
  targetKind?: "file" | "dir" | "other";
  size: number;
  mtimeMs: number;
  mode: number;
  /** Cheap extension-based guess, for the icon only. The truth comes from fs.read. */
  textHint: boolean;
}
```

`textHint` is a **guess from the name**, not a read: sampling 5000 files to draw a list is a
syscall storm, and the icon being wrong costs nothing. `fs.read` decides for real.

### `fs.read` → `fs.read.result`

```ts
{ type: "fs.read", path: string, from?: number, maxBytes?: number }
{ type: "fs.read.result", path: string, etag: string, size: number, mtimeMs: number,
  encoding: "utf8" | "utf8-bom" | "latin1" | "utf16le" | "utf16be",
  eol: "lf" | "crlf" | "mixed", text: string, lines: number,
  from: number, nextFrom: number | null, truncated: boolean,
  binary?: { reason: "nul" | "control" }, error?: string }
```

- `etag` is `${mtimeMs}-${size}`. It is the conflict contract of every write, and it is deliberately
  cheap: a hash of a 200 MB log is not worth a save.
- **Text detection** samples the first 4 KB: a NUL byte, or more than 30 % control characters
  (excluding tab, newline, carriage return and form feed), makes it binary. Binary answers with
  `binary` and **no `text`**, and the page shows the metadata card.
- **Encoding** is a BOM when there is one, else UTF-8 validated with a fatal decoder, else
  `latin1`. It is returned so the write can put the file back the way it was: rewriting a latin1
  file as UTF-8 corrupts every accent in it.
- `eol` is the file's dominant line ending, detected on the window. It round-trips for the same
  reason: CodeMirror normalises to `\n` internally, so a CRLF file would silently become LF on the
  first save.
- **Windows**: `maxBytes` defaults to `FS_READ_MAX = 2_000_000`. Past it, `truncated` is true and
  `nextFrom` gives the byte offset to continue at, **aligned forward to the next line boundary**
  (never mid-character, or the fatal decoder fails on a file that is perfectly valid).
- `from` on a request continues a window. `lines` counts the lines in the *returned* window.

### `fs.write` → `fs.write.result`

```ts
{ type: "fs.write", path: string, text: string, etag: string, force?: boolean,
  encoding?: MyClawAppFsEncoding, eol?: MyClawAppFsEol }
{ type: "fs.write.result", path: string, etag: string, size: number, mtimeMs: number,
  error?: string, conflict?: { etag: string, size: number, mtimeMs: number } }
```

- `etag` must equal the file's current etag. Otherwise the write is **refused** with `conflict`
  carrying the current state, and the app offers "reload" or "overwrite anyway" (`force: true`).
  The agent editing the same file mid-save is the case this exists for, and it is not rare here.
- The text is re-encoded with the `encoding` and `eol` the read reported (both default to the
  read's values when the app echoes nothing).
- **Atomic**: same-directory temp file, `write`, `chmod` to the original mode, `rename`. A crash
  or a full disk leaves the old file intact -- the ENOSPC of 2026-09-12 is the precedent.
- Writing a file that is binary is allowed (the page does not write binary, but a text file that
  looks binary must not be read-only by accident).
- Every write is logged (`fs.write` scope, path, size, device) and **never** the content.

### The rest

| Frame | Shape | Notes |
| --- | --- | --- |
| `fs.mkdir` | `{ path }` → `{ path }` | `recursive: false`: creating a tree silently is how a typo becomes 40 directories |
| `fs.move` | `{ from, to }` → `{ from, to }` | rename(2); refuses when `to` exists |
| `fs.remove` | `{ path, recursive? }` → `{ path }` | refuses the roots below |
| `fs.watch` / `fs.unwatch` | `{ path }` → `{ path, watching: boolean }` | one watcher per connection per path, capped at 8 |
| `fs.changed` (push) | `{ path, kind: "changed" \| "removed", size, mtimeMs }` | debounced 250 ms |

`fs.remove` refuses, by canonical path: `/`, `$HOME`, `$MY_CLAW_DIR`, the default workspace
directory, and any path that is an ancestor of the running process's own working directory. A page
that can delete the install it runs on is not a feature, and the refusal names the reason.

`fs.changed` is what the page's two behaviours are built on: in **read** mode it appends a tail
(re-reading from `nextFrom` when the file only grew) and otherwise reloads; in **edit** mode it
raises a banner and never touches the document. A file that changes under an editor is a conflict,
not a refresh -- reloading it would delete what the owner is typing.

### Session roots and transfer

```ts
{ type: "fs.session.root", threadId: string }
{ type: "fs.session.root.result", threadId: string, path: string }
```

Opened from a conversation or from a sub-agent, the page starts at that session's workspace
(`resolveWorkspaceKey`, the same resolution the run uses; a sub-agent's own `workspaceDir` when it
has one). The app knows the thread's workspace *key* but not its directory -- that mapping lives in
the server's config, and this frame is the only place it crosses the wire.

**Upload** is HTTP, not frames: `POST /fs/upload?path=<directory>` with the device bearer (the
auth `/app-update/apk` uses), multipart, one or many files, each written atomically into the
directory. Bytes over a WebSocket is a base64 tax on a phone connection and one frame size limit
away from a corrupt file.

**Download** is the mirror: `GET /fs/download?path=<file>` streams the file with
`Content-Disposition: attachment`, and the app saves it the way it already saves an APK.

## What the app draws

- One page, three modes: **list**, **read**, **edit**. The breadcrumb is built from the normalised
  path, each segment tappable.
- CodeMirror 6 for both read and edit, read-only in the read mode: the same renderer in both is
  what keeps line numbers, wrapping and highlighting from disagreeing between the two.
- One action sheet on a row: open, edit, rename, move, delete, download, copy path. Long-press
  opens it; a tap opens the file.
- **Nothing is hidden and nothing is hidden behind a toggle**: `/proc` and `node_modules` list like
  anything else. What the page owes the owner is not a filter, it is the size and the date on every
  row.
- The editor is full screen, so the keyboard problem is a single delta: the container is lifted by
  the height measured at `keyboardDidShow` and CodeMirror keeps the caret in view
  (`docs/keyboard-avoidance.md` is the doctrine; `adjustResize` stays out of the manifest because
  it is inert).
