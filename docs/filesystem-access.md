# Filesystem access: no fence

The filesystem tools (`read`, `write`, `apply_patch`, `ls`, `search`, and the browser paths that
take a local file) resolve a path and then use it. `resolveWorkspacePath`
(`src/tools/workspace.ts`) does exactly two things: an absolute path stays itself, a relative one
is resolved against the run's workspace.

There is no containment check, and that is deliberate (2026-09-14). It used to throw
`Path "<x>" escapes workspace directory.` against a boundary `bash` never obeyed -- it spawns in
the workspace and takes any absolute path in its command. So the fence was crossed by shelling
out, and its only measured effect was an error the model worked around: a sub-agent denied
`write /tmp/steal_run.sh` wrote the same file with `bash "cat > /tmp/steal_run.sh"` one call later.

## What it implies

`MY_CLAW_WORKSPACE` is a **working directory**, not a root. It is what relative paths resolve
against and the `cwd` `bash` spawns in. Read it as "where a bare filename lands", never as "the
limit of what the agent can touch".

The agent reads and writes anywhere its service user can, and that user has passwordless sudo on
this install (`docs/install-layout.md`). That autonomy is a choice, not an oversight: approvals
are off by default (`src/agent/approvals.ts`), `config.blacklist` is empty, and the tools never
ask.

## What is still refused

- **`fetch` and the browser only speak http/https.** `file:`, `data:`, `ftp:` and `gopher:` are
  different capabilities wearing the same argument: `fetch("file:///…")` would read the disk, and
  a hostile page can reach it through a 302, which is why every redirect hop is checked too.
- **`normalize-untrusted` / `invisible`** strip invisible characters from content that came from
  outside before it enters the prompt. That protects the model from an injected instruction, not
  the machine from an action.
- **`command-log`** masks secrets in the arguments it writes to the log.

## The SSRF guard went with it

`resolveAndCheckUrl` refused private, loopback, link-local and cloud-metadata addresses for both
`fetch` and the browser, with a fail-closed DNS lookup. It was removed the same day, on the same
argument: `bash` plus `curl` reach the LAN in one line, so it refused nothing the service could not
already do.

What it did buy was the difference between an automatic and an explicit request: a page, an email
or a tool result could no longer make `fetch` touch an internal address by itself. That
distinction is knowingly gone. Nothing on this path validates an address any more.
