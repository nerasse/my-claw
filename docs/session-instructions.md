# Session instructions page

What **one conversation** is loaded with, as opposed to what a workspace holds on disk.

The app reaches it from the two menus a conversation already has (the drawer's per-conversation
sheet and the chat header's), next to `Status`. Same subject, same place: a conversation.

## Why a second instructions surface

There were two answers to "what is this agent reading", and neither answered it for a thread:

- Settings > Workspaces > *workspace* (docs/instructions-page.md) shows the four prompt files of
  a **workspace**, resolved through the inheritance ladder, plus a **scan** of the nested
  `AGENTS.md` sitting in that directory tree. It knows nothing about a conversation, about the
  agent behind it, or about which of those nested files were ever read.
- `/instructions [agent]` dumps the composed prompt of an **agent type** as a markdown
  attachment. It is a dump: no layer boundaries, no origins, nothing editable, and it says itself
  that nested files are injected during a run and are therefore absent.

A conversation is what the owner actually has in front of them, and it is where the question is
asked. So the page is per thread, and it answers with the layers themselves.

## One composition, two readers

`composeSystemPrompt` (`src/agent/prompt/builder.ts`) returns the prompt as its ordered layers;
`buildSystemPrompt` is the join of it. The run sends the join, the page draws the layers. This is
the same rule the instructions page already follows for resolution (`resolvePromptFile` shared
with the loader): a second composition written to look like the first is how a page comes to
show what the runtime does not read.

Layers, in build order: `CORE`, `SOUL`, `AGENTS`, `USER`, `agent` (the agent file's mandate),
`skills`, `tools`, `platform`, `runtime`, `suggested`. The four prompt files carry their `origin`
(own / inherited / fallback / off) and the workspace they were resolved from.

Two things the model receives are appended by the page rather than by the composition, because no
file holds them: the SDK steering note (`OWNER_STEERING_NOTE`, claude-sdk backend only) and, as a
note rather than a layer, the fact that a plugin rewrote the prompt through
`transform:system:prompt`. Rendering the rewritten prompt as a layer would double the payload for
a case that is normally empty.

### What the page cannot show, and says so

- **Suggested skills** are injected into the inbound message, not into the system prompt, for the
  same cache reason as recalled memories (docs/skill-suggestions.md).
- **Recalled memories** are injected into the message, not into the system prompt.
- **Nested `AGENTS.md`** are appended to tool results, once per run, for the directories the tools
  touch. They are listed separately, from the session's own trace.

## The nested trace

`NestedAgentsCollector` is run-local by design (docs/nested-agents.md): its dedup set dies with
the run, so each file is injected at most once per run. That left no record at all: the only
trace of an injected file was inside a tool result the owner may never scroll back to.

The collector now takes an `onInject` callback, and both backends record into
`session.nestedAgents` (`src/sessions/store.ts`): path (absolute, symlinks resolved, the identity
the collector dedups on), size, first and last injection, and a `count` of the runs that paid for
it again. The list is capped at `MAX_NESTED_RECORDS` (60), dropping the least recently injected
file: the page answers "what is loaded now", so the oldest entry is the one whose absence costs
least. A file deleted since stays listed with `missing: true`, because it did shape the
conversation.

## Editing, nested included

Every layer that comes from a file is editable, and so is every nested `AGENTS.md`:

- The four prompt files open the existing editor on `{ workspace, file }`, where the workspace is
  the **conversation's**. An inherited layer therefore becomes an override of the copy shown,
  which is what "edit what this conversation reads" has to mean.
- A nested `AGENTS.md` is written through `instructions.set` with `nested` instead of `file`. The
  write goes through the same guard as any prompt file: sha of the loaded content, snapshot before
  the write, atomic write, journal entry. So `/config diff` and `/config rollback` cover a nested
  edit exactly as they cover a `SOUL.md` one.
- Creating a nested file is refused. Creating one changes *which directories carry instructions at
  all*, and no editor screen can present that decision honestly. Files are created by the agent or
  by hand, and edited here.

### The allowlist is the session's own trace

A nested path can point outside every workspace (`~/dev/some-repo/AGENTS.md` is the common case),
so the workspace-root fence that protects the workspace scan does not apply to it. The rule:

- a **relative** `nested` is resolved against the named workspace root and must stay under it,
  and must be an `AGENTS.md` -- unchanged, this is what the scan lists;
- an **absolute** `nested` is accepted only with the `threadId` that listed it, and only when that
  session's `nestedAgents` holds that exact path.

So the set of files a device can reach is exactly the set the server itself recorded reading for
that conversation. A path typed by a device is never joined to anything and never trusted on its
own word (`resolveNestedTarget`, `src/channels/my-claw-app/instructions.ts`).

## Where

- `src/agent/prompt/builder.ts` -- `composeSystemPrompt` / `PromptPart`; `buildSystemPrompt` joins.
- `src/agent/prompt/loader.ts` -- `resolveCorePrompt`: the core layer with the ladder step that
  produced it, so "workspace CORE.md" and "hardcoded constant" are distinguishable without
  comparing bytes.
- `src/agent/prompt/nested-agents.ts` -- `onInject`, `NestedAgentsRecord`,
  `recordNestedInjection`, `MAX_NESTED_RECORDS`.
- `src/agent/bridge.ts`, `src/agent/claude-sdk/backend.ts` -- record into the session.
- `src/channels/session-instructions.ts` -- the report: layers, origins, edit targets, nested
  trace, notes.
- `src/channels/my-claw-app/instructions.ts` -- `resolveNestedTarget`, `readNestedByPath`,
  `writeNestedInstruction`, and the shared `writeGuarded` behind every instruction write.
- `src/index.ts` -- wires the provider and the nested allowlist against the session manager.
