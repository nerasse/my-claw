# Sub-agent visibility

> **Note historique** : ce document a été écrit quand my-claw servait aussi Telegram et Matrix.
> Ces deux canaux ont été supprimés (seul `my-claw-app` subsiste). Les mentions et chemins de
> fichiers `channels/telegram/*` et `channels/matrix/*` ci-dessous sont conservés pour la trace
> de la décision : ils ne décrivent plus le code.

Sub-agents are addressable from any conversation by default. That is the point: a named agent with
a workspace is a shared worker, and scoping it to the chat that happened to create it would waste
it. A single owner runs this instance, so cross-chat access is a capability rather than a leak.

`spawn` takes `visibility` to narrow that: `workspace` restricts an agent to the conversations of
one workspace, `private` to its creating session. One-shot agents get `private` whether they ask
or not. `private: true` remains as a deprecated alias and loses to `visibility` when both are set.

## The workspace scope

```
global     every conversation                      (default)
workspace  every conversation of one workspace
private    the conversation that created it
```

A workspace agent is a shared worker inside one project. Two orchestrators of the same workspace
see and drive it; an orchestrator of another workspace does not see it at all.

**The scope is the spawning conversation's workspace, not the agent's.** Those are two different
things and conflating them is the trap: `agents.<name>.workspace` (and `workspaceDir`) says where
the agent's filesystem lives, which the owner may pin anywhere. Reachability follows the
orchestrator that created the agent instead, so pinning an agent to a build directory does not
hand it to whoever happens to work in that directory. `meta.workspaceKey` records that scope, and
it is written for `workspace` visibility alone -- an absent key on a global or private agent means
nothing, and must not be read as one.

**The default workspace is a scope, not a wildcard.** An agent spawned from an unkeyed
conversation is reachable from unkeyed conversations only. Treating `undefined` as "matches
anything" would make the default workspace a hole through every other one.

The caller's workspace is **resolved, never passed**: every entry point takes a session id, reads
that session, and uses its `workspace` key. A caller cannot assert a workspace it is not in, and a
workspace switch applies to reachability immediately, since the switch persists on the session. A
session that cannot be read yields no workspace, which places the caller in the default scope --
the narrowest answer, never the widest.

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
SubAgentMeta.visibility: "global" | "workspace" | "private"
SubAgentMeta.workspaceKey: string | undefined   // set for "workspace" only
isReachableFrom(meta, { sessionId, workspaceKey })
```

Four entry points check it: `list`, `send`, `kill`, `reset`. Neither a private nor an out-of-scope
workspace agent reports a distinct error to a chat that cannot reach it -- both report the same
"not found" as a nonexistent one, so existence is not confirmed either way.

`list` resolves the caller once for the whole scan rather than per entry: the caller does not
change between two files, and a read per sub-agent would make listing quadratic in disk reads.

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

**No per-chat filtering of `/agents`.** The command lists what the calling session can reach: every
global agent, the workspace agents of its own workspace, plus its own private ones. Hiding other
chats' agents inside a shared scope would defeat sharing.

**A workspace agent does not move when its workspace is renamed or removed.** `meta.workspaceKey`
is the key as written at spawn time. A removed workspace leaves its agents reachable from nothing,
visible in no roster, which is the same outcome as a conversation deleted out from under a private
agent -- they are collected by `kill`, never silently rehomed into the default scope.

**Deleting a conversation still only collects its private agents.** A workspace agent survives its
creator like a global one: another conversation of the same workspace may still be driving it.

**Parentage is not ownership.** `meta.parentSessionId` records who created an agent, and a global
agent can be driven by anyone; the bill follows the driver, not the creator. See
docs/status-command.md.
