# One bash call, one box

## Why

2026-09-22, one tool call took the server with it. The call was a Rust build that wanted the
whole machine; the machine has 11 GiB and no swap worth the name; `bashRunner` gave the command
a 45-minute wall and no memory ceiling. The kernel's OOM killer picked **the server** as the
victim -- its `oom_score_adj` was `200`, which makes a process the *preferred* one to die. The
runs in flight died with it, their sub-agents were left orphaned on `running`, and the thread
resumed as if none of it had happened (docs/run-grouping.md, `closeDead`).

A command that wants too much memory is a legitimate accident. The answer is not "agents must be
careful": it is a box.

## The box

Every `bash` call runs in a **systemd scope** with three ceilings (`tools.bash` in config.json,
docs/below):

```
setsid systemd-run --user --scope --quiet --collect \
  -p MemoryMax=<memoryMaxBytes> -p MemorySwapMax=<swapMaxBytes> -p TasksMax=<tasksMax> \
  bash -c 'echo 1000 > /proc/self/oom_score_adj 2>/dev/null; exec bash -c "$0"' <command>
```

- the cgroup counts the command and **everything it spawns** (cargo, its rustc children, their
  children) and kills *them* at the ceiling: the server and the sibling sub-agents are outside
  the scope and never see it. Measured: a 400 MB allocation under a 64 MB ceiling dies in 0.4 s
  and the process that launched it reports `137`;
- `MemorySwapMax` keeps a doomed command out of the machine's swap -- the swap is the server's
  reserve, and a command that lives in swap is a command that should have died five minutes ago;
- `TasksMax` is the fork-bomb guard;
- `oom_score_adj 1000` on the shell: if a global OOM finds no scope to blame (the host is
  saturated some other way), the children die before the server. A positive adjustment is all an
  unprivileged process may write; the server's own `-200` would need a capability the service
  user does not have.

The command itself travels as `$0` of the inner shell and is never interpolated: quoting survives
whatever it contains.

## What the owner sees

Three deaths end in SIGKILL and only two are ours to name:

- the wall: `Command timed out after 45 min and was killed.`
- the ceiling: `Killed (SIGKILL): the command hit its memory limit (8 GiB), or killed externally.
  Raise tools.bash.memoryMaxBytes in config.json to allow more.`
- anything else SIGKILL-shaped gets the same sentence without the ceiling clause.

## Configuration (`tools.bash`)

| key | default | meaning |
|---|---|---|
| `memoryMaxBytes` | `8589934592` (8 GiB) | ceiling per call. `0` = no ceiling (the scope's other limits still apply) |
| `swapMaxBytes` | `2147483648` (2 GiB) | swap one call may use. `0` = none |
| `tasksMax` | `512` | fork-bomb guard. `0` = none |
| `cgroup` | `true` | `false` runs the bare spawn of always |
| `timeoutMs` | `300000` (5 min) | the wall for one call when it passes no `timeout` of its own, clamped to [1000, 3600000] |

One call is killed after its wall unless it passed a `timeout` of its own. The timeout error
names the wall and the ways past it: re-run with a larger `timeout` (up to 3600000 ms), or detach
the job with `setsid` and poll its log. The default moved from two minutes to five on
2026-10-18: builds and test suites outgrew it (278 kills in two months, 182 of them in the
heaviest September), while detaching stays the pattern for anything that must outlive the call,
and the tool description now says so.

Zero is two different things on purpose: `memoryMaxBytes: 0` removes a ceiling (systemd spells it
`infinity`), `swapMaxBytes: 0` forbids swap (systemd spells it `0`). Hot-reloaded with the rest of
`tools`.

## Where it does not apply

- A host with **no user systemd bus** (the CI runner, most containers): the probe
  (`systemd-run --user --scope --quiet /bin/true`, once per process) says no and every call runs
  bare, exactly as before. `tests/tools/bash-limits.test.ts` covers the argv construction and the
  messages without a bus; the real kill is the gated `BASH_CGROUP_E2E=1` test.
- The machine itself. `earlyoom` is the last line of defence (it kills the biggest consumer before
  the kernel's own OOM killer, which killed the server on the 22nd), and the 8 GiB swapfile is
  the reserve. Neither is a licence for one call to have the box, that is what the ceiling is for.
