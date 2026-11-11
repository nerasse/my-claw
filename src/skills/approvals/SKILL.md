---
name: approvals
description: Ask the owner before something risky, read what is already waiting on him, and understand allow-once / allow-session / always-allow-this-call
---

# Approvals: the owner in the loop

Some tools do not run until the owner says yes: a tool in `blacklist`, and every tool of a remote
node unless he switched that off for the machine. When that happens the run stops on a prompt and
waits. This skill is about the tool you can call to ask on purpose, and about what the three
answers mean.

## Asking on purpose

```
approval(action="request", what="one sentence: what and why", tool="bash", command="df -h")
```

- `what` is what he reads first. Say what will happen and why it needs a yes, not "run a command".
- `command` (or `args`) is the exact call. It is what "always allow this exact call" matches, so
  copy it verbatim from what you are about to run.
- The run **waits with no timeout**. That is the point: an explicit ask is a run waiting on a
  person, never a machine answer of "no". It ends on his answer, on Stop, or when he types instead.
- Answers: `approved` (run it once), `approved-always` (he allowed this exact call for good on that
  machine: run it, and do not ask again for it), `denied` (do not run it, do not ask again for the
  same thing), or a cancel from Stop/typing (treat as not done, say so plainly).

## Reading what waits

```
approval(action="list")
```

Every prompt still waiting, across conversations and machines: `bash on archy`, since when, with
or without a timeout. Use it when a sub-agent looks hung: it may simply be waiting on a yes. Never
answer a prompt for him, and never spawn a second agent to do the same thing "in the meantime".

## What already runs without asking

```
approval(action="grants")
approval(action="grants", origin="archy")
```

Do this **before** planning work on a remote node, not after the first prompt surprises you. Each
machine gets one line: whether anything asks before a call there (`nothing asks`, `asks before:
bash, memory`, `asks before every call`), and under it every exact call the owner already allowed,
with its arguments.

- `origin` takes `local`, a node's name or its id. Omit it for every machine.
- A grant covers **one exact call**: the arguments as written, key for key. Reusing the arguments
  listed is the whole point; adding one argument (`timeoutMs`, a flag) asks again.
- `(inert)` means the machine is not paired any more: it is a leftover in the config, not a
  permission. Do not plan around it.
- You cannot grant yourself anything, and you should not ask for a grant to avoid a prompt you have
  not hit yet. Read this list, use what is there, and ask when the work genuinely needs a new call.

## When to ask

Ask when the action is destructive or irreversible and a mistake is not undone by the next step:
deleting data outside the workspace, rewriting history on a remote, publishing, sending something
external in his name, changing a machine's configuration.

Do not ask for what he already told you to do, for reading files, or for anything you would refuse
to do on a no. **Ask once per decision, not once per step**: one yes covers the command and the
checks that follow it. A run that asks three times in a row is a run he starts answering blindly.

## What a grant is

A standing grant is narrow on purpose: one tool, one machine, one exact set of arguments. A
different command, a different path, or another node asks again. Never present a grant as covering
"anything like this": it does not, and he will find out the hard way.

## Against the automatic gate

The automatic prompts (a blacklisted tool, a node that must ask) time out after two minutes and
count as a refusal. That is why a tool call you did not expect to ask can fail on its own: the
answer is usually `approval(action="request", ...)` before you call it, not a retry in a loop.
