# Siphon: one model for a whole tree

A conversation can pin every run under it to a single model -- the orchestrator, each sub-agent,
each sub-agent of a sub-agent, the browser agent. The pin is read from the conversation at every
run, so a change (or a removal) reaches the next run of every level without a restart and without
a broadcast that could miss one.

The mode is called **Siphon** in the UI. The code stays descriptive: `session.pinModel` is the pin,
`forcedModel` is the one step in the model resolver that it takes, and `rootSessionOf` /
`pinModelOf` are the two functions that read it.

## What it is, and what it is not

Siphon is **the pin**. It chooses which model the whole tree runs.

It is **not** the resume. Waiting for a quota reset and picking the conversation back up is general
behaviour -- `decideQuotaWait`, the tick that fires it, the pill, Continue -- shared with the
**Retry when the quota returns** switch (docs/quota-retry.md). Siphon changes only which model the
resumed run lands on.

**A pin also asks for the wait.** "This model, whatever it takes" is not a promise a spent account
can keep by failing: pinning a tag whose candidates are all empty used to fail the run, and the
owner had to know to turn on a second switch before the mode did anything (2026-11-10). So
`waitsForQuotaOf` answers "the switch, or a pin", and that one predicate is what the bridge, the
sub-agent runner, the compaction and both arm paths read. A pinned tree parks its orchestrator, its
sub-agents and their children at the reset instead of dying -- the same pill, the same tick, the
same resume.

The switch keeps its own value throughout: a wait armed by a pin does not turn it on, and the menu
row still shows the switch's state (its hint says the pin is holding the wait). Clearing the pin
**releases** a wait the pin armed, unless the switch is on -- it was the pin's wait, and the owner
just turned the mode off.

What a pin does *not* change is the order inside a tag. The route is walked as written, and a
resumed run starts again at its first candidate, which is what makes the first model of a tag the
priority whenever its quota comes back.

A run that is still going does not move back up on its own: it stays on the candidate that answered,
because switching mid-run throws away the prefix cache the conversation has been building there. The
route is walked again when the run fails on its wall or when the conversation resumes -- and it is
walked from the top, so the first candidate with room is the one the resume lands on. For the same
reason the wait asks the whole route (docs/quota-retry.md): the candidate a resumed run never called
is the one whose reset is worth waiting for.

## Where the pin lives

On the **root conversation's** session, in `meta.json`, beside the retry setting:

```ts
// SessionData
pinModel?: string;   // an exact provider/model reference
```

Not in `config.json`: it is a decision about one conversation, it must survive a restart with
that conversation, and it belongs to that conversation's account rather than the installation.

**Children never carry a copy.** A copy would go stale the first time the owner changed the pin
while a chain was running, and every level would then disagree about the model it is on. Each run
walks to its root and reads the pin there -- `rootSessionOf` follows `attributionParent`
(`invokedBy || meta.parentSessionId || self`) until it stops moving, bounded by the set of sessions
already visited so a corrupted chain that loops cannot spin.

## How it wins

`forcedModel` is the one field in `RunModelRequest` that skips the precedence chain entirely. The
resolver pushes it as the only step; nothing below it is considered. That is exactly the promise
Siphon makes, and it is why the pin does **not** go through `modelOverride`:

| Path | Where it applies | What it beats |
|---|---|---|
| `forcedModel` (Siphon) | `src/agent/bridge.ts`, `src/subagents/runner.ts` | everything, an explicit `spawn model:` included |
| `sessionModel` (a pick) | the resolver's first step | the agent pin and the global default |
| `session.modelOverride` | a conversation's own stored pick | the agent pin |
| agent file `model:` | the agent's own chain | the global default |

A pick can be a tag with a route to walk, so it keeps its own step. Siphon pins one subject, and a
subject may be a tag: the route then travels with the pin exactly as it does with a pick, and a wall
moves along it. What the pin rules out is a *sibling* -- any model the owner did not name.

## A pin that no longer resolves

The pin is validated when it is set (`model.siphon.set` refuses an id the catalogue does not serve),
so the case that remains is a model deleted after the pin was made. The resolver then behaves as it
does for any stale step: it reports what it could not run, and the run fails with that named rather
than silently running something else. A silent substitution is the one outcome this mode may not
have -- the owner pinned a model, and a different one answering would be a lie.

## The frames

- `model.siphon.set` `{ threadId, model? }` -- sets the pin, or clears it when `model` is absent.
  Validated like any other pick and answered with `model.result`, which every device already reads.
- `model.result` carries `siphon?: string` next to `model`. Separate on purpose: `model` is what a
  run of *this* thread resolves to, and a sub-agent under a pinned conversation runs the pin even
  when its own row would name something else.

## The UI

The conversation menu (drawer row and chat header, same list) has one entry under the retry switch:

| Row | Meaning |
|---|---|
| `Siphon · off` | each run picks its own model |
| `Siphon · on · <model>, every agent` | the whole tree runs this model |

It opens the model picker with the effort and window steps removed: the pin is a model, and an
answer that also pinned an effort would change what sub-agents under it inherit, which is a
different promise. There is no Apply screen -- the last decision applies, like every other picker.
The row above the list turns the mode off, since off is the default a pin has no equivalent of.

A tag is offered like any other subject, and the server resolves it exactly as any other path does:
`apiModel` becomes the model the tag aliases, the tag's own effort travels with it, and a tag whose
route lists several candidates keeps that whole route -- so a pin on a tag is a pin on what that tag
means, kept as one decision rather than resolved in the client.

What a tag does *not* do yet is choose among its candidates by available quota: the run lands on the
first one that is reachable, which is the resolver's rule everywhere else. Ordering a route by what
the bars say is phase 2 (docs/quota-pin-plan.md). What a pinned tag does do is get walked when a
candidate hits its wall -- remaining candidates, then the tag's own global default -- and the wait
only arms when nothing in the route is left (docs/quota-retry.md).

## Hot reload

The pin is read at the start of every run, so:
- changing it takes effect on the next run of every level, with no restart;
- removing it takes effect the same way, including for a child that had been running on it (the
  run already resolved keeps its model; the one after goes free);
- it survives a restart, because it lives in the session's meta and not in memory.

## What it does not do yet

- **Tags ordered by available quota** (phase 2). A route walked in the order the owner wrote it is
done -- a wall moves to the next candidate before anything waits (docs/quota-retry.md). A route
*reordered* by what the bars say, returning to the top of the list when one reopens, is drawn in
docs/quota-pin-plan.md and not implemented.
- **The vision reroute.** A model without image input plus an image is still a question this mode
  does not answer by itself: the pin names a model, and the reroute that saves the run picks
  another one. Current behaviour is the resolver's, unchanged by Siphon.

## Tests

`tests/subagents/siphon.test.ts`: an explicit spawn model loses to the root's pin; an agent file's
own `model:` loses to it too; a child of a child reaches the same root; a removal reaches the next
run without touching the child; with no pin the chain decides exactly as before; `rootSessionOf`
terminates on a cycle.
`tests/my-claw-app-adapter.test.ts`: the frame is validated, refused when the controller is absent,
and answered with the state a device reads.
