# Draft sync

> **Note historique** : ce document a été écrit quand my-claw servait aussi Telegram et Matrix.
> Ces deux canaux ont été supprimés (seul `my-claw-app` subsiste). Les mentions et chemins de
> fichiers `channels/telegram/*` et `channels/matrix/*` ci-dessous sont conservés pour la trace
> de la décision : ils ne décrivent plus le code.

What is typed and not sent yet follows the owner across their devices, and survives a reboot.

Scope: the `my-claw-app` channel only. It is the only channel with a composer of its own; Telegram
and Matrix drafts belong to their clients.

## The problem

`my-claw-app/src/core/drafts.ts` already keeps a draft per conversation, in memory, on the device.
It exists for two reasons, both still valid: the chat screen is unmounted whenever a page covers it
(Settings, Files, Archives), and it is *not* remounted between conversations, so a draft written in
one followed the reader into the next and could be sent there.

What it cannot do is cross a device. The owner has five paired devices (one phone, four browsers),
reaches the same conversations from all of them, and a message begun on the phone was unreachable
from the desk. The same argument the thread pins were moved server-side for (`core/pinned.ts`):
per-device state means every surface has its own private idea of the truth.

The file's own comment argued the other way, that "a draft is a thought in progress, not a document,
and the process dying is a good enough reason for it to be gone". That holds for a crash. It does
not hold for the auto-update, which restarts the server on its own schedule and would drop a draft
the owner did not know was fragile.

## Where it lives, and why not in the session

**Not in `SessionData`.** A session file reaches 4 MB, it is rewritten whole, and the autosave picks
up any dirty session every 2 s. A field there would mean rewriting megabytes per burst of typing:
the one place in this codebase where a per-keystroke write meets a whole-file rewrite.

One file for every draft instead, `$MY_CLAW_DIR/my-claw-app/drafts.json`, written atomically:

```json
{ "version": 1, "drafts": { "my-claw-app/thread/neras/<uuid>": { "text": "...", "ts": 1755690000000 } } }
```

Keyed by **session id**, not thread id. The wire speaks thread ids because that is what a device
knows, and `resolveSessionId` maps one to the other at the edge. The store speaks session ids
because that is what `session:deleted` carries, which makes the lifecycle a single key delete
instead of a lookup that can miss.

The whole map is held in memory and *is* the runtime state. The file is a durability detail: no read
happens after boot, so listing threads or opening one costs no IO.

## Lifecycle: it dies with the session, twice over

1. **The hook.** `SessionManager.deleteSession` already emits `session:deleted`. The store
   subscribes and drops the key. Deleting a conversation therefore takes its draft with it, through
   the same path that takes its files and its private sub-agents.
2. **The boot sweep.** Every key whose session file no longer exists is dropped when the store
   opens. This is not redundancy for its own sake: a draft is unsent text and the only reference to
   it is a key in a map, so a delete path that forgot to prune would leave it on disk forever with
   nothing pointing at it. One `readdir` at boot closes that hole for good.

Clearing a conversation's history (`chat.clear`) does **not** clear its draft. Emptying what was
said is not the same as throwing away what is being written.

Sending does. When the server accepts a `chat.send` on a thread it drops that thread's draft and
tells the other windows, so the composer that was mirroring it empties instead of holding a copy of
a message that has already been sent.

## Caps

- **64 KB per draft.** Both ends know the constant. Past it the device stops syncing that draft and
  keeps it locally, exactly as it behaves today. Truncating would silently eat text, and refusing
  the whole thing loudly is not worth an error path for a case a composer reaches by accident only.
- **200 drafts.** The oldest by `ts` are dropped past that. A draft older than the two hundred
  newest is not a thought in progress any more.

## Optimisation, since this is the one feature with a keystroke in its path

Three gates, in order, and each one is what makes the next one cheap:

1. **The device debounces.** `draft.set` goes out 500 ms after the last keystroke, never per
   keystroke, and never at all when the text is identical to what this device last sent. Typing a
   two hundred character message is a handful of frames, not two hundred.
2. **The server compares before it acts.** An unchanged text is not stored, not written and not
   broadcast. A device reconnecting and re-sending its draft is free.
3. **The disk write is coalesced.** A change marks the map dirty and arms a single 1 s timer; the
   file is written once per second of activity at most, and `MyClawAppAdapter.stop()` flushes what
   is pending. `stop()` and not the `app:shutdown` hook: hook emission is fire and forget, adapter
   shutdown is awaited before `process.exit`.

## Wire protocol

Two additive frames plus two additive fields. Nothing is versioned: an older app ignores a frame
type it does not know (`parseServerFrame` is a whitelist), and an older server never sends one.

```ts
/** Device -> server. Empty text clears. Debounced device-side. */
{ type: "draft.set"; threadId: string; text: string }

/** Server -> the owner's *other* windows. Never echoed to the sender, which already has it. */
{ type: "draft.changed"; threadId: string; text: string; ts: number }
```

- `MyClawAppChatHistory` gains `draft?: string`, on the newest page only. Opening a thread is
  exactly when its draft is wanted, `resume.ts` already refetches the open thread's history on every
  reconnect, and a paginated page reaching backwards has no business carrying it.
- `MyClawAppSessionSummary` gains `hasDraft?: boolean`. One bit, so the thread list can mark a
  conversation with unsent text without shipping every draft in every listing.

`ts` is the server's clock, assigned on write. Device clocks drift, and last-write-wins on a drifting
clock loses the wrong write.

## The one subtle part: applying a remote draft

A `draft.changed` that lands while the owner is typing must not touch the composer. Replacing the
text mid-word both loses characters and throws the caret to the end. It is the same failure the
instructions editor already guards against (`settings-handlers.ts:639`: a push "overwrites the draft
someone else is typing").

The rule, device-side: **a remote draft is applied only when the local composer is empty, or not
focused.** Otherwise it is stored in the local map and shown the next time the thread is opened. So
the phone left on the desk catches up, and the window being typed in is never interrupted.

There is no merge, no conflict UI and no operational transform. Last write wins, per conversation.
A draft is one person's unsent sentence on two screens, not a shared document.

## Attachments do not sync

The local draft also holds `PendingAttachment[]`: local URIs (`content://` on Android, blob handles
on the web) and upload state. A phone's URI means nothing in a browser, so text is what crosses.
Attachments stay device-local, exactly as they are today.

## Privacy

A draft is unsent text that now lives on the server. Two guarantees:

- **It never reaches a model.** It is not in `SessionData`, so no prompt builder can see it: the
  guarantee is structural, not a filter someone has to remember.
- **It is never logged.** Lengths and thread ids only, never content, in a channel whose logs are
  read routinely for debugging.

## Tests

Server:

- the store: set/clear/read; an unchanged set reports no change and schedules no write; the 64 KB
  cap; the 200 entry cap drops the oldest by `ts`; a reopened store reads back what was written.
- `session:deleted` drops the key; the boot sweep drops a key whose session file is gone and keeps
  one whose file is there.
- the adapter: `draft.set` reaches the other socket and never the sender; `chat.send` clears the
  draft and broadcasts the clear; `chat.history` on the newest page carries the draft and a
  paginated page does not; `session.list` reports `hasDraft`.
- the leak test: a stored draft is absent from the prompt built for that thread.

App:

- the store: a remote draft is applied when the composer is empty, and is not applied when it holds
  text; the debounce sends once for a burst; an identical text sends nothing.
- `chat.history` seeds the draft; switching threads keeps both drafts apart.
