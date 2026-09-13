# Two session logs a short write tore

Hand-written, synthetic, and shaped after what a full disk produced on 2026-09-12
(`ENOSPC: no space left on device, write`) -- the mechanism is in `docs/session-log.md`, annexe E.
No real conversation is kept here, and none is needed: what these files prove is a shape.

Both reproduce the same accident. A write stops mid-token and leaves a **stump** with no newline;
the next append opens the file in append mode and lands on the same line, behind it; and the line
that carried the link between two halves of the branch is now unreadable. Read naively, every
ancestor of the leaf disappears -- `pathOf` walks parents from the leaf and stops at the hole.

| File | The stump | What it proves |
|---|---|---|
| `stump-without-identity.jsonl` (line 10) | the first bytes of a `tool` entry, cut inside its command string, with **no** `id`, `seq`, `parentId` or `ts`: the write died before those fields | the entry glued behind it is recovered and, since it names an id no line holds, put behind the entry written just before it. The branch is whole again, root to leaf. The tail carries the other shape a repair has to deal with: a run that died of an error and, on the version that wrote this, rewound to its own question. Nothing marked that fork, so its three entries go back on the branch between the question and the `failure` filed on it |
| `stump-with-identity.jsonl` (line 8) | a `spawn_state` entry that **does** carry `id`, `seq` and `parentId`, cut inside its `"ts"` mid-digits | the same recovery when the stump looks like an entry: a truncated suffix cannot parse, so the boundary that wins is the last one, and the entry behind it comes back. Its own parent was never written (the `seq` jumps over it), and the log is one unbroken branch once it is put behind the line before it. Its tool output carries `{"type":"` twice, so the fixture also proves an object start inside a payload is not mistaken for a boundary |

Both are plain JSONL, a few kilobytes, and meant to be read: `sed -n 10p` on the first one shows
the accident in one screen.

Ids are readable on purpose (`a-01`, `b-07`). The ids the stumps would have carried (`a-10`,
`b-09`) are named by their children and appear nowhere else: that absence is the damage.
