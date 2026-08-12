# Sub-agent navigation

The app can see every sub-agent a conversation has spawned, open a named one as a real chat,
talk to it, and hand its answer back to the parent on purpose.

Status: **spec approved, not implemented.** Open decisions are settled in "Decisions taken".

## What the user gets

1. A counter in the chat header. Tap it, a sheet lists the sub-agents of this conversation,
   grouped named/temporary then by agent type.
2. The `spawn` tool card in the transcript becomes a door: one tap into the sub-agent it created.
3. Inside a sub-agent, a real chat: history, streaming, tool cards, reasoning, composer. The
   header names the parent, so the way back is never a guess.
4. An explicit action on any sub-agent answer: hand it to the parent.

## Scope

In: the four items above, for sub-agents reachable from the open conversation.

Out of v1, deliberately:

- Reading a dead one-shot's transcript from the SQLite archive (see "Temporary rows" — v1 needs
  no such read path).
- Spawning a sub-agent from the UI. Only the model spawns.
- Talking to a sub-agent *while it runs on behalf of its parent*. Structurally impossible today,
  see "Constraint 2".

## Three constraints that shape the design

### Constraint 1 — a one-shot no longer exists

`mode: "run"` sub-agents are deleted when the run ends (`subagents/runner.ts:260`). They cannot be
reopened or chatted with. Only `mode: "session"` sub-agents live on disk and are re-invocable
(`runner.ts:100-103`).

The two categories the user asked for are therefore not cosmetic — they carry different
capabilities, and the UI must not offer an action that cannot exist:

| | named (`mode: "session"`) | temporary (`mode: "run"`) |
| --- | --- | --- |
| id | `subagent/<displayName>-<hex4>` | `subagent/run-<uuid>` |
| on disk | yes, survives reboot | no, deleted at end of run |
| open as chat | yes | **no** |
| re-invoke | yes (`send`) | no |
| row action | open the chat | scroll to its `spawn` card |

### Constraint 2 — nobody can write into a running sub-agent

The injection mailbox is gated on `depth === 0` (`agent/bridge.ts:393`,
`agent/claude-sdk/backend.ts:514`) and sub-agents always run at `depth = 1`
(`runner.ts:289`). A message sent to a busy sub-agent is FIFO-queued by
`SubAgentRegistry.enqueue` (`subagents/registry.ts:38-56`), not injected.

So the composer inside a sub-agent, while that sub-agent is running, must say **queued**, not
pretend to be live. The message is delivered when the current run ends. Lifting the depth gate is
out of scope and not obviously desirable: the gate is what keeps a sub-agent's context from being
rewritten under its parent's feet.

### Constraint 3 — "return to the parent" cannot be automatic

A sub-agent's result reaches its parent only because the parent's `spawn`/`send` tool call is
awaiting it (`runner.ts:108`, `tools/spawn.ts:96-112`). When the *user* chats with a sub-agent,
no parent call is pending — the parent already got its answer. There is nothing to return to.

The inverse direction does work: the parent runs at `depth 0`, so
`runRegistry.enqueueInjection(parentSessionId, ...)` (`core/run-registry.ts:115`) is open while the
parent is running, and a plain new run serves when it is idle. Hence C2: an explicit per-message
action, never an implicit mirror.

## Identity and status

From `SubAgentMeta` (`sessions/store.ts:96-110`) and `SubAgentInfo` (`subagents/types.ts:9-15`):
`id`, `displayName`, `type`, `messageCount`, `status`, `visibility`, `parentSessionId`,
`createdAt`, plus `modelOverride` on the session.

Two facts the UI must respect:

- **`displayName` is not unique.** It is chosen by the model at spawn time; the `-<hex4>` suffix is
  what disambiguates (`registry.ts:15-21`). Rows show the full id, never the bare name, or two
  `research` agents become indistinguishable.
- **`status` is only `idle | running`**, derived from the in-memory queue map
  (`registry.ts:58-60`). There is no persisted `done` or `failed`. v1 does not invent one: a named
  row shows `running` or `idle`, and outcome (`ok`, duration) is shown only for temporary rows,
  where it comes from the `spawn` tool card that is already in the transcript.

## Thread mapping — how a sub-agent becomes addressable

Device thread ids must match a strict charset with no slash, so a session id that is not a
`my-claw-app` conversation needs a round-trippable handle. Cron already does exactly this
(`sessions/store.ts:225-238`, hooked in `sessions/manager.ts:89-90`), and that is the precedent to
follow.

Cron can use a readable encoding because its ids are `[0-9a-f]{12}` and digits. **Sub-agent ids
cannot**: `displayName` is raw model input, never sanitized (`registry.ts:18`,
`sanitizeSessionId` only strips `..` and NUL, `store.ts:220-222`). It may contain spaces, dashes,
slashes, unicode. No string encoding of it is safely reversible.

So the handle is opaque and content-addressed:

```
threadId  = "sub-" + sha256(sessionId).slice(0, 16)
sessionId = scan sessions/subagent/*.json for the file whose id hashes to the handle
```

- `subagentSessionToThread(sessionId)` / `subagentThreadToSession(threadId)` in
  `sessions/store.ts`, next to the cron pair.
- The reverse scan is the same `readdir` + `loadSession` walk `SubAgentRunner.list` already does
  (`runner.ts:204-221`), over a directory holding a handful of files.
- The app never computes a handle. Every frame that names a sub-agent carries its `threadId`.

Sanitizing `displayName` at spawn is a real fix and lands **first, as its own commit** (see
"Prerequisite"): a name containing `/` currently writes outside `sessions/subagent/` and then never
appears in `listExistingIds`, silently degrading the uniqueness check. It does not remove the need
for the opaque handle, because the agents already on disk keep their unsanitized names.

## Prerequisite — a separate commit, landing before the feature

`SubAgentRegistry.generateId` (`registry.ts:15-21`) interpolates raw model input into a session id
that becomes a file path. Fix, on its own, with its own test:

- Sanitize `displayName` to a safe charset at spawn (`tools/spawn.ts` is where it enters).
- Assert a name containing `/`, `..`, a NUL, a newline and unicode lands inside
  `sessions/subagent/` and round-trips through `listExistingIds`.

Kept out of the feature commit: it is a path-escape bug, and a diff that mixes it with a
navigation feature hides both.

## The part that is not free

Mapping the thread id makes `session.history` work for a sub-agent immediately. It must **not** be
allowed to make `chat.send` work by itself. If a message on a sub-agent thread fell through to the
normal router path it would run the sub-agent's session as a top-level conversation:

- at `depth 0`, so it would receive the five sub-agent tools that `SUBAGENT_EXCLUDED_TOOLS`
  removes on purpose (`tools/registry.ts:21`), letting it spawn further agents;
- outside `SubAgentRegistry.enqueue`, racing a parent-driven run on the same session file and the
  same SDK resume — precisely the race documented at `runner.ts:74-76`;
- with the default prompt, tools, skills, model and workspace instead of the ones resolved from
  `meta.type` (`runner.ts:292-328`).

Therefore: **a `chat.send` on a sub-agent thread is dispatched to `SubAgentRunner.send`**, which
already owns the queue, the scoping, the workspace and the model override.

`SubAgentRunner.send` calls the non-streaming `handleMessage` (`runner.ts:343`), so as it stands
the user would stare at a frozen screen until the whole answer lands. A chat that does not stream
is not "a real session". v1 adds a streaming path to the runner:

- `SubAgentRunner.send` takes an optional streaming sink (`onToken`, `onToolUse`, reasoning sink),
  and calls `handleMessageStreaming` (`agent/backend.ts:38-49`) when one is supplied.
- Parent-driven runs pass no sink and keep the current non-streaming behaviour, so nothing about
  `spawn`/`send` from the model changes.
- The app channel supplies the sink, keyed on the sub-agent's `threadId`, reusing the existing
  pushers in `channels/my-claw-app/stream.ts`. Streaming, tool cards and reasoning then work in a
  sub-agent chat with no new stream code.

## Protocol

Additive frames, validated by the app's `FRAME_TYPES` set, so no coupled release
(`docs/my-claw-app-channel.md` must be updated in the same change).

### Client to server

| Frame | Payload | Meaning |
| --- | --- | --- |
| `subagents.list` | `{ threadId }` | roster for the conversation `threadId` is open on |
| `subagents.report` | `{ threadId, parentThreadId, messageId }` | hand a sub-agent message to its parent |

`threadId` on `subagents.list` is the **parent** conversation. Scoping is not optional: the roster
is `SubAgentRunner.list(registry, callerSessionId)`, which applies `isReachableFrom`
(`runner.ts:33-37`, `:213`) so a private sub-agent of another conversation is invisible.

### Server to client

| Frame | Payload |
| --- | --- |
| `subagents.list.result` | `{ threadId, agents: SubAgentEntry[] }` |
| `subagents.changed` | `{ threadId, count, running }` |

```ts
interface SubAgentEntry {
  threadId: string;       // opaque handle, what the app opens
  id: string;             // subagent/<name>-<hex4>, shown verbatim
  displayName: string;
  type: string;           // agent type, the second grouping level
  messageCount: number;
  status: "idle" | "running";
  visibility: "global" | "private";
  model?: string;
  createdAt: string;
}
```

`subagents.changed` is a nudge, not state: emitted to the owner's socket from the existing hooks
`subagent:spawn|complete|killed|reset` (`hooks/types.ts:248-259`), it carries only what the header
badge needs so the counter is live without polling. The app refetches the roster on open.

Add `subagents` to `MyClawAppErrorScope` (`channels/my-claw-app/types.ts:786-805`).

## UX

### A2 — the header counter

```
┌────────────────────────────────────────┐
│ ☰   Fix the auth bug                   │
│     gpt-5 · 12k       ◈3   📁    ⋮     │
└────────────────────────────────────────┘
```

- Sits between the status dot and the folder icon in `ChatScreen.tsx:308-346`.
- Hidden entirely when the count is 0, so a conversation that never spawned anything gains no
  clutter.
- `◈3` when all idle; the glyph takes `palette.accent` and a trailing `●` when any is running.
- `accessibilityLabel`: `"3 sub-agents, 1 running"`.

### The roster — `AgentsScreen`, full screen

Grouped on two levels: named/temporary, then agent type.

```
┌──────────────────────────────────────────┐
│ ‹   Agents                               │
│     Fix the auth bug                     │
├──────────────────────────────────────────┤
│  NAMED                                   │
│                                          │
│  research                                │
│  ◈ research-a3f1                idle  ›  │
│    12 msgs · private · gpt-5             │
│  ◈ research-b2c9                idle  ›  │
│    3 msgs · global · gpt-5               │
│                                          │
│  general                                 │
│  ◈ writer-88c2             ● running  ›  │
│    4 msgs · global · sonnet-4.6          │
│                                          │
│  TEMPORARY                    read-only  │
│                                          │
│  research                                │
│  ◇ run-1a04                   failed  ›  │
│    8.1s                                  │
│                                          │
│  general                                 │
│  ◇ run-7d21                        ✓  ›  │
│    4.2s                                  │
└──────────────────────────────────────────┘
```

`NAMED` / `TEMPORARY` are the major headers (uppercase, `font.micro`, `letterSpacing 0.4`, the
label convention of `ToolCard.tsx:82`); the agent type is the minor header (`font.meta`,
`textMuted`). Two header weights, two grouping levels, no indentation beyond one step.

Ordering, deterministic:

1. `NAMED` before `TEMPORARY`.
2. Within a category, types sorted: any type containing a running agent first, then alphabetical.
3. Within a type: `running` first, then most recently active first, then id.

Implementation, following `JobsScreen` / `JobSessionsScreen` exactly:

- `src/app/AgentsScreen.tsx`, rendered as `[StyleSheet.absoluteFill, styles.stage]` at the end of
  `AppShell`'s `SafeAreaView`, next to the jobs block (`AppShell.tsx:3007-3061`).
- It is outside the `KeyboardAvoidingView`, so it pads `insets.top` itself and calls
  `useDismissKeyboard()` — the Android trap where an open keyboard eats the first back press
  (`core/keyboard.ts:60-71`).
- Scrolling uses `useScrollIndicator()` like every other list in the app.
- State: `agentsOpen: boolean` in `AppShell`, entered from the header counter, with its own branch
  in the `BackHandler` chain (`AppShell.tsx:1057-1336`) placed just above the `jobsOpen` branch.
- **No change to `ActionSheet`.** Its `children` render outside the `ScrollView`
  (`ActionSheet.tsx:84` vs `:85-113`), so a long roster in a sheet would have clipped silently at
  the 70% cap; the full screen removes that constraint rather than working around it.

Picking a row **closes the roster** and opens the sub-agent. The roster is a chooser, not a level
you come back to: that is what keeps B1's promise literal — the back row inside a sub-agent always
names the parent conversation, and the stack never goes three deep.

**Temporary rows need no server data.** The parent transcript already holds the outcome of every
one-shot: the `spawn` tool card carries `args.mode`, `args.type`, `ok`, `durationMs` and `output`
(`core/chat.ts:28-31`, `core/protocol.ts:110-118`). v1 derives the `TEMPORARY` group client-side
from the chat items, which is why no SQLite listing function is required. `AgentsScreen` receives
them from the parent thread it was opened on. Tapping a temporary row closes the roster and scrolls
to its `spawn` card. Consequence to accept: one-shots from *other* conversations are not listed —
consistent with them being forced `private` (`runner.ts:247`).

### A3 — the spawn tool card as a door

`ToolCard` is today a single `Pressable` wrapping the whole card (`ToolCard.tsx:19-57`). Nesting a
button inside a button is an accessibility fault: the card must first become a `View` whose head is
the toggling `Pressable`, with the sub-agent row as a sibling. Small, and it removes the nested
control.

```
▾ spawn   research-a3f1                        4.2s
  ARGUMENTS
  { "type": "research", "mode": "session", … }
  OUTPUT                                       COPY
  Three candidate causes…
  ┌──────────────────────────────────────────┐
  │ ◈  open research-a3f1 · idle          ›  │
  └──────────────────────────────────────────┘
```

- Shown only when `name === "spawn"`, `ok`, `args.mode === "session"`, and the roster holds a
  matching entry (the agent may since have been killed).
- Collapsed cards are untouched: the door appears in the expanded body only, so transcript density
  is unchanged.
- For `args.mode === "run"` there is no door — the session is gone. The card is the whole record,
  which is exactly what the temporary rows point back to.

### B1 — inside a sub-agent

```
┌────────────────────────────────────────┐
│ ‹  Fix the auth bug                    │  ← whole row tappable: back to parent
│ ◈ research-a3f1 · research        ⋮    │
│   idle · 12 msgs · private              │
├════════════════════════════════════════┤  ← accent rule, full width
│                                        │
│   ... the sub-agent's own chat ...      │
│                                        │
├────────────────────────────────────────┤
│ Message research-a3f1…            ➤    │
└────────────────────────────────────────┘
```

- The back row **names the parent** rather than saying "back". That is the requirement: the way
  out is legible without memory of how you got in.
- A 1px `palette.accent` rule under the header, full width, persistent while scrolled: every chat
  screen in this app looks alike, and without a standing marker a user will type into a sub-agent
  believing they are talking to the main agent.
- Composer placeholder carries the sub-agent id for the same reason.
- While `status === "running"`: the send button stays enabled and the message is accepted, but the
  composer hint reads `queued · delivered when the current run ends` (Constraint 2). Lying about
  this would be worse than the limitation.
- `⋮` holds `copy id`, `open workspace`, `reset`, `kill`.

Both destructive actions go through an `ActionSheet` confirmation with `danger: true`, and their
wording states the asymmetry the code actually has:

| Action | Server | Confirmation text |
| --- | --- | --- |
| `reset` | `archiveSession` then a fresh session, `meta` and workspace preserved (`runner.ts:194-200`) | "Clear this agent's memory? Its transcript is archived, its workspace and identity are kept." |
| `kill` | `deleteSession`, **no archive** (`runner.ts:184`) | "Delete research-a3f1? Its transcript is gone for good." |

New frames `subagents.kill` / `subagents.reset` `{ threadId, parentThreadId }`, both routed through
the existing runner methods so `isReachableFrom` still gates them (`runner.ts:181`, `:191`) — the
UI must not become a way to reach a private agent the tools refuse. Both reply with
`subagents.changed`. On `kill` the app returns to the parent, since the thread it was on no longer
exists.
- Android hardware back returns to the parent, wired like `fromJobSessionsRef`
  (`AppShell.tsx:1284-1296`), inserted in the existing `BackHandler` chain (`:1057-1336`) above
  the archives branch.
- Navigation state: `subagentThread: { threadId, id, parentThreadId, parentTitle } | null`, plus
  the entry in the back chain. No new screen component — `ChatScreen` takes an optional
  `subagent` prop and renders the two-line header instead of the normal one.

### C2 — hand the answer to the parent

An action on the bubble menu of any agent message inside a sub-agent (`bubbleMenu` already exists,
`AppShell.tsx:2825-2840`):

```
        ╭──────────────────────────────────────╮
        │  The cause is the token cache, l.88  │
        │                                      │
        │  → hand to Fix the auth bug          │
        │  copy                                │
        │  ⋯                                   │
        ╰──────────────────────────────────────╯
```

`subagents.report { threadId, parentThreadId, messageId }`. Server side:

1. Resolve both threads; verify the sub-agent is reachable from the parent session
   (`isReachableFrom`) — a report is a write into the parent, so it gets the same gate as `send`.
2. Build the parent-visible text: `` `[research-a3f1] <message>` ``. The provenance is part of the
   payload, not decoration: the parent's model must not mistake it for the user's own words.
3. If the parent is running, `runRegistry.enqueueInjection(parentSessionId, msg)`; if the mailbox
   is closed or absent (returns `null`), route it as a normal new run. This is the documented
   injection contract (`docs/injection.md`, `run-registry.ts:109-122`).
4. The parent conversation shows it as a normal user-side turn, so the transcript stays honest
   about what the model was told.

The app then closes the sub-agent and lands back on the parent, where the run is visibly under way.
Handing something over is the end of the errand, and staying behind would leave the user watching a
screen where nothing further happens while the real work restarts elsewhere.

## Traps

- **30-day pruning.** `pruneOldSessions` deletes sessions older than 30 days and exempts only
  `my-claw-app/` (`store.ts:331-361`). A UI that calls a named sub-agent "re-invocable" while the
  server silently deletes it is lying, so `subagent/` joins `PRUNE_EXEMPT_PREFIXES`
  (`store.ts:339`). Accepted cost: the directory is no longer bounded by time, and `kill` from the
  `⋮` becomes the only way to reclaim it — which is part of why kill is in v1.
- **`displayName` is unsanitized model input** (`registry.ts:18`). Rendered raw it can carry
  newlines or RTL overrides. Rows must clamp to one line and strip control characters.
- **A killed agent leaves a stale door.** The `spawn` card outlives the agent. The door is
  rendered only when the roster still lists it, so it disappears on refresh rather than opening a
  dead thread.
- **Two agents, one suffix.** `generateId` guarantees whole-id uniqueness, not suffix uniqueness.
  Never key UI rows on `hex4` alone.
- **`invokedBy` is rewritten by every `send`** (`runner.ts:169`), so it is not the parent — the
  stable parent is `meta.parentSessionId` (`store.ts:120-124`). The back row must use the latter.

## Tests

Server:

- `subagentSessionToThread` / `subagentThreadToSession` round-trip, including a `displayName` with
  spaces, dashes, unicode and a slash; and a handle that matches nothing.
- `subagents.list` scoping: a private sub-agent of conversation A is absent from B's roster and
  present in A's; a global one is in both.
- `chat.send` on a sub-agent thread goes through `SubAgentRunner.send`: prove it by asserting the
  run is serialized against a concurrent parent-driven `send` on the same agent, and that the
  spawn tools are absent from the run's registry.
- Streaming sink: tokens, tool cards and reasoning frames arrive on the sub-agent `threadId`, and
  a parent-driven `spawn` still streams nothing (the existing contract).
- `subagents.report` injects into a running parent, and falls back to a fresh run when the mailbox
  is closed. Reject a report whose sub-agent is not reachable from the parent.
- `subagents.kill` / `subagents.reset` refuse a sub-agent that is not reachable from the caller,
  with the same indistinguishable "not found" as the tools (`docs/subagent-visibility.md:32-34`).
  After `reset`, the archive holds the old transcript and `meta` plus workspace survive; after
  `kill`, the file is gone.
- A named sub-agent older than 30 days survives `pruneOldSessions`, and a `my-claw-app` thread of
  the same age still gets pruned (proving the exemption is scoped, not blanket).
- The leak test that matters: a sub-agent's transcript must never be replayed into the parent's
  prompt except through `subagents.report`. Make it fail on purpose first, as with reasoning.

App:

- Grouping and ordering: fixtures with two types, mixed statuses, named and temporary; assert the
  exact row order.
- The header counter is absent at 0, shows the running marker, and matches the roster length.
- The door renders only for `mode: "session"`, `ok`, and a roster hit; absent otherwise.
- Back returns to the parent from both the roster route and the tool-card route, hardware back
  included; and the roster is not on the stack behind a sub-agent.
- A temporary row scrolls to its `spawn` card and does not attempt to open a chat.
- `kill` and `reset` each require the confirmation sheet; `kill` returns to the parent.

## Decisions taken

1. Roster is a full-screen `AgentsScreen` (`JobSessionsScreen` pattern). `ActionSheet` gains
   nothing.
2. `kill` and `reset` both in the sub-agent `⋮` in v1, each behind a danger confirmation whose
   wording states whether the transcript survives.
3. `subagent/` is exempt from 30-day pruning.
4. A 1px accent rule under the header marks "inside a sub-agent".
5. Reporting to the parent navigates back to the parent.
6. `displayName` sanitizing lands first, as its own commit (see "Prerequisite").

Consequences of 1 that were not separately asked: picking a row closes the roster rather than
stacking on top of it, and the roster owns a `BackHandler` branch of its own.

## Delivery order

1. `displayName` sanitizing, its own commit with its own test.
2. Server: thread mapping, `SubAgentRunner.send` streaming sink, the five frames, pruning
   exemption, channel doc. Shippable and testable with no app.
3. App: `AgentsScreen`, header counter, `ToolCard` restructure and door, sub-agent chat header,
   report and destructive actions.

Step 2 is additive and validated by the app's `FRAME_TYPES` set, so it needs no coupled release.
