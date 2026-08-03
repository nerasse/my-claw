# Sub-agent visibility

Sub-agents are addressable from any conversation by default. That is the point: a named agent with
a workspace is a shared worker, and scoping it to the chat that happened to create it would waste
it. A single owner runs this instance, so cross-chat access is a capability rather than a leak.

`spawn` takes `private: true` to restrict one to its creating session. One-shot agents get it
whether they ask or not.

## Why one-shots are forced private

They were already invisible, but by accident rather than by rule. `runOneShot` passed
`meta: undefined`, and `list()` skips any session without metadata -- so an unnamed agent never
appeared, and nothing enforced that.

Attributing their token usage required giving them metadata, which would have made them listable
and therefore drivable from every other chat. The visibility flag is what keeps the accounting fix
from becoming an exposure, so the two land together.

The flag is defensive today rather than load-bearing: `runOneShot` never writes the session to
disk, so `list()` cannot see it regardless. That is worth stating plainly, because a mutation test
that flips `private` to `global` for one-shots survives -- correctly. It becomes load-bearing the
moment one-shots persist, or `list()` reads from anywhere but the directory.

## Where it is enforced

```
SubAgentMeta.visibility: "global" | "private"
isReachableFrom(meta, callerSessionId)
```

Four entry points check it: `list`, `send`, `kill`, `reset`. A private agent does not report a
distinct error to a chat that does not own it -- it reports the same "not found" as a nonexistent
one, so its existence is not confirmed either way.

An unknown caller (empty session id) never matches a private agent, including one whose parent is
also unknown. Otherwise two blanks would authorise each other.

Enforcement needed the caller's identity, which none of these tools had. `__sessionId` is now
injected alongside `__depth`, `__message` and `__signal`, derived from the session rather than from
the message: a message alone cannot tell a thread session from its room.

## The bug this uncovered

`kill` validated nothing:

```ts
async kill(id: string): Promise<string> {
  await deleteSession(id);
```

`deleteSession` takes any session id. `kill_agent` pointed at `matrix/room/!x:example.org` would
have deleted a conversation, and the model chooses that argument. It now requires a `subagent/`
prefix, existing metadata, and reachability. `reset` already checked for metadata, which is why it
was never exposed the same way.

## Deliberately unchanged

**No per-chat filtering of `/agents`.** The command lists what the calling session can reach, which
is every global agent plus its own private ones. Hiding other chats' agents would defeat sharing.

**Parentage is not ownership.** `meta.parentSessionId` records who created an agent, and a global
agent can be driven by anyone; the bill follows the driver, not the creator. See
docs/status-command.md.
