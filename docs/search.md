# Search: one engine, one semantics

The `search` tool finds content in files. It runs on **ripgrep**, resolves how to get it without
asking anyone, and falls back to GNU grep (server) or a local walker (node) with a banner when
neither is available. Written 2026-10-18, after the tool-adoption review: the old GNU-grep
version silently answered "No matches" for `*.{ts,tsx}` and `src/**/*.ts` (65 of 420 measured),
scanned node_modules, and lost every measure against `bash grep` on the way agents actually work.

## Engine resolution (server)

Order, first hit wins (src/tools/ripgrep.ts):

1. `MY_CLAW_RG_PATH` — an explicit binary, for tests and overrides.
2. `<tree>/vendor/ripgrep/rg` — the pinned release build; a release tarball ships it
   (`packaging/build-tar.sh` fetches and checksums it), so an installed tree works offline.
3. `~/.my-claw/tools/ripgrep/<version>/rg` — a previously downloaded copy.
4. `rg` on PATH.
5. One download, checksum-pinned per platform, cached under (3).
6. Nothing → GNU grep fallback, announced in the result:
   `[engine: grep fallback, ripgrep unavailable: ...]` (no .gitignore handling, hidden files
   included; path-based globs refused with a named error, never a wrong answer).

Version and per-platform SHA-256s live in `ripgrep.ts`; the version there is the one CI installs
and the release ships. `MY_CLAW_SEARCH_ENGINE=grep` rules ripgrep out entirely (tests);
`MY_CLAW_RG_NO_DOWNLOAD=1` forbids the download while still allowing all local sources.

The node-client resolves the same way minus the vendor directory (its cache lives under the node
directory), and its last fallback is a local walker — same skip list, same headers, same
messages, banner carrying the difference (JavaScript regex, no .gitignore rules).

## What is searched, what is skipped

Defaults: ripgrep's own rules (hidden files skipped, `.gitignore`/`.ignore` respected — also
outside a git repository, via `--no-require-git`) plus a built-in skip list for generated trees
that are not always ignored:

`node_modules`, `__pycache__`, `vendor`, `target`, `dist`, `build`, `coverage`

`all: true` drops both layers (`--no-ignore --hidden`) and searches everything. An explicit
`path` **inside** a skipped directory is searched anyway: the skip list guards traversals, never
a path the caller named (ripgrep does this natively; the grep fallback drops a root's own name
from its exclude rules to keep the promise). A miss says what the defaults skipped, so an empty
answer is never mistaken for an empty tree.

## Parameters

- `path` (optional; defaults to the run's workspace), `paths[]` for several roots in one call.
  Each root runs as its own engine call with `cwd` set to the root, so a path glob like
  `src/**/*.ts` reads relative to each root, the way it does after a `cd`.
- `pattern` — Rust regex (`\d`, `\s`, `\w`, `\b`, `|`, groups; no lookaround, no backreferences).
- `glob` — filters file paths; braces work (`*.{ts,tsx}`, `src/**/*.ts`). Alone, it lists files.
- `mode` — `files` (default) paths only, `count` per-file counts, `content` the matching lines.
- `context` (symmetric) or `after`/`before` (asymmetric), content mode, max 40; the two forms
  refuse to combine instead of guessing.
- `limit` (default 250, max 2000) and `offset` — the result leads with the total count, and a
  page always says which slice it is (`showing results 3-12 of 40 ... continue with offset 12`).
- `ignoreCase`, `extract` (`-o`), `invert` (`-v`), `exclude[]`/`excludeDirs[]` (added on top of
  the defaults).
- `searches: [...]` — a batch of full queries in one call, one header per query; one shared
  100KB output budget cuts the batch with `[batch cut at query n of N]`, never silently.

The tool description carries the same story (the prompt repeats no tools, 2026-10-04 decision):
what is skipped, how to reach it, and the standing invitation to prefer this over `bash grep`.

## Bounded calls (2026-11-24)

A `rg` over `/` held a sub-agent's run for 16 hours after its owner pressed Stop: nothing bounded
the engine, and the Stop waited on it. Every engine call is now bounded on three sides.

- **Wall.** `SEARCH_WALL_MS` (60 s) per call, one wall for the whole call and not one per root:
  a five-root search buys five minutes otherwise. A wall answers `Search timed out after N s in
  <root>` -- a result, because a narrowed query is the fix, not a retry.
- **Stop.** The run's abort signal kills the engine (`SIGKILL`) and throws `AbortedError`, so a
  Stop ends the call instead of waiting for it. Also when the Stop landed before the spawn.
- **Collection cap.** `MAX_COLLECTED_LINES` (20 000) lines are read, then the engine is killed and
  the result says `20000+`: past the cap the count is a floor, never a silent truncation. The cap
  is what makes a broad pattern cheap -- the same query that produced 55 MB of stdout, a 562k-entry
  array and a 700 ms call for a 250-line page answers in 22 ms (measured on a 20k-file, 102 MB
  tree). A sorted engine emits its matches in path order, so the prefix kept is the one a full run
  would have led with; `offset` still pages anywhere inside it, and the floor is stated.

The rewrite is the reading, not the search: `--sort path` is what makes the prefix deterministic
and costs about 2x traversal, which a 250-line page does not notice but a stable `offset` paging
does need. Modes that must touch every file (`files`, `count`) gain nothing from the cap and are
bounded by the wall alone.

## Measured baselines (2026-10-18)

- Orchestrator: 73 search calls since 15/08 against ~19 000 file searches done with bash grep;
  the reasons, the numbers and the acceptance criteria live in `docs/tools-revamp.md`.
- The adoption check to re-run: recon-vs-action + search counts per week (`/var/tmp/scan/`
  scripts on the analysis machine).
