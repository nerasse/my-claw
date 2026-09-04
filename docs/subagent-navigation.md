# Sub-agent navigation

The app can see every sub-agent a conversation has spawned, open a named one as a real chat,
talk to it, and hand its answer back to the parent on purpose.

Status: **implemented.** Open decisions are settled in "Decisions taken". Two items of the original
spec were never built and are not planned as written: a `subagents.report` / `subagents.changed`
frame pair (kill and reset answer with `subagents.list.result` instead), and the automatic return to
the parent refused in "Constraint 3", which is now an explicit hand-back instead.

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

### Constraint 1 — a one-shot is a temporary, kept until its parent dies

`mode: "run"` sub-agents keep their session on disk after the run (`subagents/runner.ts`,
`runOneShot` saves it). They are unnamed workers, so they stay `private`: reachable from the
conversation that asked for them, invisible everywhere else, and **deleted with that conversation**
(`deleteChildrenOf`, hooked to the app's conversation delete). The transcript is also indexed in
the search archive as before.

The two categories the user asked for remain real, with different lifecycles:

| | named (`mode: "session"`) | temporary (`mode: "run"`) |
| --- | --- | --- |
| id | `subagent/<displayName>-<hex4>` | `subagent/run-<uuid>` |
| visibility | `global` by default, `private` on ask | always `private` |
| lifespan | until killed, or deleted with the parent if `private` | deleted with its parent conversation |
| open as chat | yes | **yes** |
| re-invoke | yes (`send`) | yes, from its own conversation |
| row action | open the chat | open the chat |

One-shots that died before this change do not come back; only future runs are kept.

### Constraint 2 — a sub-agent is steerable mid-run (since the app drives it)

Originally the injection mailbox was gated on `depth === 0`, so a message sent to a busy sub-agent
waited in the per-agent FIFO until the current run ended. With the app opening sub-agents as chats,
that read as a dead chat, so the gate is gone:

- `SubAgentRunner.executeRunWithSession` opens a mailbox for every sub-agent run
  (`runRegistry.openMailbox`), parent-driven runs included. It is a mailbox without a controller:
  the abort stays the shared root signal, or a parent's `/stop` would no longer reach its children.
- The engine drains its session's mailbox at the same boundaries the root path uses
  (`bridge.ts` drain/drainOrClose, `claude-sdk/backend.ts` generator), whatever the depth. Only the
  app can write there — chat channels resolve to their own sessions and can never name a
  `subagent/*` one — so there is nothing else that could arrive.
- The router injects (`enqueueInjection`) when the sub-agent's mailbox is open, and falls back to
  the queued send otherwise. An injection the run could not absorb is settled with `RerouteSignal`
  and rerouted to a fresh, streamed run, exactly like the root path.

A parent-driven run streams to the sub-agent's thread like an app-driven one, turn switches
included. It did not at first: the model-driven stream sink carried no `onTurnSwitch`, so an
injected message was absorbed but its answer melted into the bubble already in flight, and
`message:injected` — emitted only from that callback — never fired. The owner's bubble therefore
stayed marked "queued for the next turn" for good, and the answer was only findable by reopening
the thread. The sink now seals the bubble, opens a fresh one addressed to the steering message, and
emits the event, which is what lifts the mark. The sink also reads its streamer from the map on
every call rather than capturing it, since that swap is exactly what a turn switch performs.

Live tool output follows the same rule: `tool:execute:progress` is a global hook, and matching only
the root session dropped every chunk a sub-agent produced, so a long command in a child ran blind.
Each chunk is routed to the streamer of the session that emitted it, and only for a child the
current run is showing — another run's sub-agent paints in its own window.

### Constraint 3 — "return to the parent" cannot be automatic

A sub-agent's result reaches its parent only because the parent's `spawn`/`send` tool call is
awaiting it (`runner.ts:108`, `tools/spawn.ts:96-112`). When the *user* chats with a sub-agent,
no parent call is pending — the parent already got its answer. There is nothing to return to.

The inverse direction does work: the parent runs at `depth 0`, so
`runRegistry.enqueueInjection(parentSessionId, ...)` (`core/run-registry.ts:115`) is open while the
parent is running, and a plain new run serves when it is idle. Hence C2: an explicit per-message
action, never an implicit mirror.

### The hand-back, as built

**Who called this agent is a fact nothing recorded.** `meta.parentSessionId` is the creator and
`invokedBy` is overwritten by every run, so neither answers "which conversations is this agent
working for" -- the question the owner is really asking when handing an answer back. A global agent
serves several, and the creator is not always among the ones still interested. `session.callers`
(`sessions/store.ts`, `recordSubAgentCaller`) is that list: one entry per driving conversation with
its first and last use and a run count, newest first, written by both `spawn` and `send`. It is
capped at 20 entries, dropping the least recent, and the creator is never dropped -- it is the one
entry the owner can always expect to see.

**Reading the list is authorised exactly like driving the agent.** `callersOf` applies
`isReachableFrom`, and an unreachable agent answers like a missing one, as everywhere else. The list
it returns is also the allow-list a hand-back is checked against: a target the owner could not have
been shown is refused. A caller whose conversation is gone comes back marked `unreachable` rather
than being dropped, because "that one is no longer there" is worth showing.

**Two frames.** `subagents.callers` answers the asking socket alone -- it is a menu opening, not a
state change. `subagents.handoff` is broadcast, since it writes into other conversations and every
window must learn what landed. It reports a per-target outcome instead of a single ok: one target
being gone must not hide the ones that worked.

**Which bubble, resolved by the replay view.** The ids the owner taps are the ids `history()` minted,
and they are derived from the position of the entry in the replayed page, not from the message index
in the session. So the adapter resolves `messageId` to text through `store.history()` and hands the
text to the controller. Deriving the id a second time elsewhere would be one drift away from handing
back the wrong turn. Only an assistant bubble is eligible: the owner's own question tells the parent
nothing, and a tool card is an implementation detail of the run.

**Two modes, because "return this" means two different things.** `ask` delivers the text as a real
turn in the target conversation, through the same path a typed message takes
(`deliverOwnerTurn`), so a target with a run in flight parks it in that run's mailbox and an idle one
opens a fresh run. The orchestrator acts on it, and it costs tokens. `note` files it in the target's
command journal, the display-only channel, so it reads back after a reload without ever reaching a
model. Capped at three targets per hand-back: each `ask` starts a run somewhere else, and one tap in
a menu must not be able to fan out without bound.

## Identity and status

From `SubAgentMeta` (`sessions/store.ts:96-110`) and `SubAgentInfo` (`subagents/types.ts:9-15`):
`id`, `displayName`, `type`, `messageCount`, `status`, `visibility`, `parentSessionId`,
`createdAt`, plus `modelOverride` on the session.

Two facts the UI must respect:

- **`displayName` is not unique.** It is chosen by the model at spawn time; the `-<hex4>` suffix is
  what disambiguates (`registry.ts:15-21`). Rows show the full id, never the bare name, or two
  `research` agents become indistinguishable.
- **`status` is only `idle | running`**, derived from the in-memory queue map
  (`registry.ts:58-60`). There is no persisted `done` or `failed`. Every row, named or temporary,
  shows `running` or `idle`; the run's outcome (`ok`, duration) stays on its `spawn` card in the
  transcript, where it always lived.

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
already owns the queue, the scoping, the workspace and the model override. `MessageRouter` refuses
a `subagent/` session outright when no sender is wired, rather than falling through: falling
through is the dangerous half of the branch.

### Who may drive a sub-agent from the app

`isReachableFrom` answers "may this conversation drive that agent", and it needs the calling
conversation. A `chat.send` names only the sub-agent, so it carries **`parentThreadId`**: the
conversation the roster was read from.

This is not a claim taken on trust. It is resolved to a session id and handed to the runner as the
caller, where the existing rule matches it against the sub-agent's recorded `parentSessionId`. The
app's path therefore has **no rule of its own** — one rule, applied in one place, for the `send`
tool and the app alike.

The fallback is the safe one rather than the permissive one: absent or malformed, the caller is
`""`, which `isReachableFrom` refuses for a `private` sub-agent and accepts for a `global` one
(`runner.ts:33-37`). An old app, or a crafted frame, reaches exactly what any other conversation
could already reach.

| Sub-agent | `parentThreadId` | Result |
| --- | --- | --- |
| private, parent = this conversation | that conversation | driven |
| private, parent = another conversation | any | not found |
| private, any parent | absent | not found |
| global | anything, or absent | driven |

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
| `subagents.kill` | `{ threadId, parentThreadId }` | delete the sub-agent, transcript included |
| `subagents.reset` | `{ threadId, parentThreadId }` | archive its transcript, keep its identity |

There is no `subagents.report` frame, and this spec was wrong to ask for one. Handing an answer to
the parent is a message in the parent conversation, so it is a plain `chat.send` on the parent
thread whose text quotes the sub-agent. The router already injects that into a running parent and
starts a fresh run otherwise (`router.ts:147-155`), which is exactly the behaviour this section
described building by hand. The app formats the quote, because that is where the text already is.

`subagents.kill` and `subagents.reset` answer with `subagents.list.result` for the parent thread
rather than an acknowledgement, matching how every other mutation in this channel replies
(`adapter.ts`, `handleSessionRename`). A refusal is an `error` on the `subagents` scope and sends no
roster, so a roster can never be read as confirmation.

`threadId` on `subagents.list` is the **parent** conversation. Scoping is not optional: the roster
is `SubAgentRunner.list(registry, callerSessionId)`, which applies `isReachableFrom`
(`runner.ts:33-37`, `:213`) so a private sub-agent of another conversation is invisible.

### Server to client

| Frame | Payload |
| --- | --- |
| `subagents.list.result` | `{ threadId, agents: SubAgentEntry[] }` |

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

There is no push frame for roster changes either. The app refetches on opening a conversation, on
`chat.run.end`, and after a mutation (which answers with the roster anyway). A run that spawns three
sub-agents therefore updates the counter when it ends rather than mid-flight — an acceptable lag for
a secondary affordance, and the alternative is a push path with hook wiring and per-socket scoping
for no other gain. Should live counts ever matter, the hooks
`subagent:spawn|complete|killed|reset` (`hooks/types.ts:248-259`) are already there to carry them.

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

**Temporary rows come from the server, like the named ones.** A kept one-shot is on disk and
scoped `private`, so the roster of its parent conversation lists it; `groupRoster` splits the
answer into `named` and `temporary` on the `subagent/run-` prefix. Tapping a temporary row opens
its chat, exactly like a named one — its header names the parent, its transcript is the run's.
One-shots from *other* conversations are absent, as `private` requires.

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
- For `args.mode === "run"` there is no door — a one-shot's id never appears in the card's args, so
  it cannot be matched to a roster entry. Its row in the roster is the door.

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
- Sending while the sub-agent is running injects the message into that run (Constraint 2): no
  queue, no waiting for the run to end. When the run is parent-driven and therefore non-streaming,
  the answer is not streamed live — it is written to the sub-agent's history and visible on the
  next `session.history` refresh. The composer stays a normal composer: there is no longer a
  "queued" state to describe.
- `⋮` holds the session actions a sub-agent shares with a conversation, then the ones that are its
  own. See "The two session menus" below: the entries are built once, for both.

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
  `my-claw-app/` (`store.ts:331-361`). A UI that calls a sub-agent "re-invocable" while the server
  silently deletes it is lying, so `subagent/` joins `PRUNE_EXEMPT_PREFIXES`
  (`store.ts:339`). Reclaiming the space is `kill` from the `⋮`, or deleting the owning
  conversation — which cascades to its private sub-agents (`deleteChildrenOf`).
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
- A one-shot survives its run on disk, stays listed for its parent and hidden from every other
  conversation, and can be driven again.
- `deleteChildrenOf`: private children of the removed conversation die, a `global` one and another
  conversation's private one survive, and a running one is spared (its run would resurrect the
  file).
- Removing a conversation through the app's session store triggers the cascade with the right
  session id, after the conversation itself is gone.

App:

- Grouping and ordering: fixtures with two types, mixed statuses, named and temporary; assert the
  exact row order, with `subagent/run-` entries landing in `temporary`.
- The header counter is absent at 0, shows the running marker, and matches the roster length.
- The door renders only for `mode: "session"`, `ok`, and a roster hit; absent otherwise.
- Back returns to the parent from both the roster route and the tool-card route, hardware back
  included; and the roster is not on the stack behind a sub-agent.
- A temporary row opens the one-shot's chat like a named row, and its header names the parent.
- `kill` and `reset` each require the confirmation sheet; `kill` returns to the parent.

## The two session menus

A sub-agent is a real session, so nearly every action of the conversation `⋮` already resolves
correctly on it: `handleModel`, `handleChatStop` and the `/status` command all go through
`SessionManager.resolveSessionId`, which maps a sub-agent handle to its own session
(`commands.ts:97`). They were simply never offered inside a sub-agent, so changing a busy agent's
model or reading its context meant leaving the chat.

The menus are therefore **not symmetric, and not written twice**. One builder emits the entries
that belong to a session; each menu adds its own and drops what does not apply.

| | Conversation | Sub-agent |
| --- | --- | --- |
| Model, Effort/window, Status, Instructions, Session files, Refresh, Stop, Copy transcript | shared builder | shared builder |
| Pin, Archive, Rename, Change workspace | yes | **no** |
| Copy id, Workspace, Clear memory, Delete | no | yes |

What a sub-agent drops, it drops because the action would do nothing observable: a sub-agent is
deliberately absent from the drawer (`selectThread` never records it as `lastThreadId`), so pinning
or archiving one has no surface to act on. Offering an action that silently does nothing is worse
than not offering it.

The rule is the same one `enterThread` exists for: two hand-written lists of the same actions drift,
and the drift is only found months later, one forgotten entry at a time.

`Workspace` is the only genuinely new entry. It shows the directory the agent's tools work in and
copies it -- the question `workspaceKey` does not answer, since that one names the orchestrator the
agent belongs to. It rides on `workspaceDir` in `SubAgentInfo` and in the wire entry, read from
`meta.workspaceDir`, which the spawn has always written. Absent on an agent spawned before the
field existed, and the entry is then not offered.

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
