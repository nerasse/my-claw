# Conversation folders

What a folder is, where its state lives, and why each of those choices was made.

A folder is a **place**: the owner files a conversation into it, the drawer draws one section per
folder, and the conversations nobody filed keep a section of their own. There is exactly one level.
Nesting is not reserved "for later" -- it is absent, because a drawer on a phone cannot show three
levels of it without a navigation of its own.

## The conversation carries the folder, the folder carries its name

```ts
// meta.json of a conversation (src/sessions/meta.ts)
folderId?: string;      // absent = not filed

// ~/.my-claw/my-claw-app/folders.json, per owner (src/channels/my-claw-app/folders.ts)
interface Folder { id: string; name: string; rank: number; workspace?: string }
```

The other shape was a list of conversation ids inside the folder, and it is wrong three times over:
a conversation could sit in two folders and neither would be the truth; moving one would be a
remove-then-add that can half-land; and deleting a folder would either lose what it pointed at or
need a reverse index to find out what to do with it. With `folderId` on the conversation, a move is
one write on one file, and a folder can never own anything.

**Deleting a folder unfiles its children and does nothing else.** The conversations keep every
message, their title, their workspace and their archive state; they simply stop being filed. The
folder leaves the list first, so a crash in the middle leaves conversations pointing at a folder
nobody can see -- repaired by deleting it again, since the sweep is idempotent -- rather than a
folder whose children silently point somewhere else.

## Server-side, like the pinned list it replaced

`~/.my-claw/my-claw-app/folders.json` is written by the server, keyed by owner, one file for the
whole install. Written on every mutation and awaited, not debounced: a folder changes on a
deliberate gesture, and losing the name of one to a timer at shutdown is not a trade worth making
for a few writes a week. (The draft store debounces for the opposite reason: it has a keystroke
behind it and a burst is normal.)

The owner reaches the same conversations from the phone and from the browser. A cabinet kept per
device is not a cabinet: each client would file the same conversation somewhere else and both would
be right. So every mutation answers with the refreshed `session.list.result` **broadcast to every
socket of the owner**, exactly as `session.pin` did before it -- a conversation filed on the phone
is filed in the browser.

## Ranks

`rank` is dense from 0 and rewritten as a block: the order of the sections. A new folder appends,
because one that landed on top would push down what the owner reads by position. A removal
renumbers, so the hole is not handed to the next folder. A reorder moves the ids it names and
leaves the others in place, after them -- a drop says where the dragged folders go and nothing about
the ones the device could not see.

## `workspace` on a folder is not a scope

It records where the folder was born, and it does two things: it defaults the workspace of a
conversation created from inside the folder, and it keeps an empty folder visible under that
workspace filter in the drawer. It never restricts what can be filed there: a folder holds
conversations from anywhere, and the workspace a conversation runs in stays its own field.

## What is not here

No sub-folders, no conversation in two folders, no folder as a permission or a scope, no export
format. Each of them would change what a folder *is*, and the drawer is built on it being one place.
