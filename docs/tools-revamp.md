# Tools revamp

Status: **decided and implemented 2026-10-18** for search, bash, read, conversation_search and
fetch (server); browser items 2.1-2.4 and node release plumbing remain open. Decisions taken by
the owner in the 2026-10-18 review of the tool-health analysis (checks at `8d5e015`, 0.7.116),
implementation after his "fais le tout" on the same day.

Shipped in this pass:
- `search`: ripgrep engine with pinned per-platform acquisition and grep fallback
  (`src/tools/ripgrep.ts`), shared core (`src/tools/search-core.ts`), new surface (paths[],
  after/before, offset, extract, invert, all, exclude, excludeDirs, batch), one semantics for
  server and node, description rewritten. See `docs/search.md`.
- `bash`: 300 s default wall, 1 h max, `tools.bash.timeoutMs`, actionable timeout message,
  description enriched (docs/bash-limits.md).
- `read`: `offset`/`limit` with exact continuation hints (no more `sed -n` for paging).
- `conversation_search`: output cap 32k -> 64k.
- `fetch`: one retry on 429/5xx honoring Retry-After, short-lived GET cache, both injectable
  for tests.
- Packaging: the release tarball ships the pinned ripgrep (build-tar.sh); CI installs ripgrep
  so the suite exercises the real engine.

Still open: the node release does not yet ship ripgrep assets (the download covers it on first
use, the local walker covers no-network); the Anthropic hex-escape 400 is logged with its payload
size but not reproduced (needs the offending body; the image clamp shrinks the class of request
that produced it).

Shipped in the second pass (same day, "continue le plan"):
- `browser`: a window another task holds yields to one of the asking run's own windows; a stale
  ref heals through its fingerprint (role, name, nth) after a restamp, uniquely or not at all; a
  handler that died on a destroyed execution context is replayed once (sidecar/server.mjs,
  sidecar/snapshot.mjs, sidecar/handlers.mjs, windows.ts). See docs/browser.md, "Self-healing".
- `media`: an image's dimensions are clamped under the provider ceiling (7600 px) even when its
  bytes are small, which was the measured 8000 px 400.


## Why

Measured on 1 416 sessions (103 521 tool calls):

- `search` is healthy (1.0% failures) but barely adopted: 73 calls by the orchestrator since
  15/08 against ~19 000 file searches done with `bash grep`. The reasons are mechanical:
  `glob` is a basename fnmatch that silently returns "No matches" for `*.{ts,tsx}` and
  `src/**/*.ts` (65 of 420 measured "No matches"); no exclusions, so repo scans return
  node_modules noise (43 of 44 files in a direct test); single path, no asymmetric context,
  no pagination, no batching, while 86% of files-mode hits lead to per-file content searches.
- `browser` family: 7.7% failures over 20 918 operations; October alone 10.1%, with window
  contention (115), locator timeouts (151), stale refs (55), destroyed contexts (40).
- `fetch`: 22.4% failures lifetime, 18.9% in October; no retry, no cache.
- `read` accepts only `path` (no offset/limit, 100 000-char wall), which pushes large-file
  reading into `bash sed` (3 314 commands read-and-grep in one call).
- `bash`: 278 commands killed at the 120 s wall; the timeout message teaches nothing.

## Decisions (owner, 2026-10-18)

1. **Search engine: ripgrep, bundled.** rg ships with the release (per platform, resolved at
   boot); when rg is absent the tool falls back to GNU grep with the documented degraded
   semantics. The node-client search is aligned on the same engine and the same semantics.
2. **Default ignores.** The default scan skips: rg's own defaults (hidden files/directories,
   `.gitignore` inside a git repository, `.ignore`/`.rgignore`) plus a built-in list for
   generated trees that are not always ignored: `node_modules`, `__pycache__`, `vendor`,
   `target`, `dist`, `build`, `coverage`. The description names what is skipped, results say
   when ignores were active, and `all: true` searches everything. An explicit `path` that
   lies inside an ignored directory is searched anyway (the list guards tree scans, not
   deliberate targets).
3. **Batch: no query-count cap.** `searches: [...]` takes any number of queries; one shared
   output budget (the existing 100 KB) cuts the batch with a clear "batch cut at query N"
   marker. Per-query `limit` is honored.
4. **Browser**: auto-pick a free window before failing (the error already tells the agent to,
   the code does not); stale ref triggers one transparent re-snapshot + retry; destroyed
   execution context retries once; images are downscaled before reaching the provider
   (the >8000 px rejection); the hex-escape 400 gets a safe truncation boundary + a local
   log of the offending body.
5. **read**: optional `offset`/`limit` (chars). Default window unchanged (100 000); the
   truncation message carries the exact next call.
6. **fetch**: one retry on 429/5xx honoring `Retry-After`, plus a short-TTL per-session URL
   cache (the 275 same-URL re-fetches).
7. **conversation_search**: output cap 32 000 -> 64 000 chars.
8. **bash**: default wall raised to 300 s, explicit `timeout` up to 3 600 000 ms, new
   `tools.bash.timeoutMs` config for the default, the timeout error becomes actionable
   ("re-run with timeout: N", "setsid for jobs that must outlive the call"), description
   enriched. Reference check: opencode = 120 s default and killed; pi = no default; codex =
   10 s yield then resume (no kill); we keep a wall (unattended cron must not hang) but stop
   punishing ordinary builds.
9. **python-in-bash edits** (assert+replace, 4 776 commands) are a supported flow: documented,
   not blocked, not instrumented for now.
10. **SearXNG** degradation (51 messages in October) is an infra task for the owner.
11. The search tool keeps its name (`search`) and its places (server + node).

## Lots

Delivery order. Each lot is independently releasable, server first.

### 1. Search / ripgrep (the big one)

1.1 **Engine**: bundle rg (server + node builds), resolve at boot, fallback grep with a
    degraded-mode note in the result. One semantics everywhere.
    Acceptance: the same query on the same tree returns the same files server-side and
    on a node; `rg --version` absence path tested.
1.2 **Silences and schema**: brace expansion `*.{ts,tsx}`; a glob containing `/` or `**`
    gets an explicit message ("filters file names, not paths"); a 0-result with a glob
    adds a hint; `path` optional (defaults to the workspace); schema errors say what to
    pass. Acceptance: replay the 69 real malformed globs from history, zero silent
    "No matches".
1.3 **Coverage**: `paths[]`, `exclude`/`excludeDirs` (on top of defaults), `after`/`before`,
    `offset` + `head_limit`, mode `extract` (-o), `invert` (-v), `all`.
    Acceptance: the top main skeletons (single-file content | head, -A blocks, multi-file,
    multiple --include, --exclude-dir) each become one `search` call with identical lines.
1.4 **Batch**: `searches[]`, shared budget, per-query headers.
    Acceptance: rewrite the compact-app-audit sweep (files -> per-file content) in <=2 calls.
1.5 **Guidance**: 1-2 description lines ("prefer this over bash grep for finding things in
    files"; "respects .gitignore"; what is skipped). No system-prompt layer (04/10 decision).
    Acceptance: description length check; no duplication with the tool schema.

### 2. Browser

2.1 Free-window auto-fallback before the contention error; guaranteed window release at
    task end; metrics. Acceptance: window-in-use < 20/month.
2.2 Stale ref: re-snapshot + retry once. Acceptance: stale-ref error rate ~0.
2.3 Context destroyed during navigation: retry once. 
2.4 Image downscale (>8000 px) before provider send; hex-escape boundary fix + local log.
    Acceptance: zero "exceed max allowed size" and zero "end of hex escape" 400s.
Target: family failure rate < 5% (October: 10.1%).

### 3. fetch

3.1 One retry on 429/5xx with `Retry-After`; 3.2 per-session URL cache (short TTL).
Acceptance: failure rate measured on the same domains 30 days later; re-fetch count down.

### 4. Finitions

4.1 read offset/limit. 4.2 conversation_search cap 64k. 4.3 bash message + description +
    config key. 4.4 docs: search semantics (one page), python-in-bash edits as supported.
Acceptance: read truncation < 5%; no behavior change outside the named paths.

## Explicitly not touched

Fence, ERE, counts (already in); bash memory box; browser page ownership / frozen tabs;
Continue; tool-set consolidation; apply_patch (healthy, 2.8% failures October).

## Measurement

Replay `/var/tmp/scan/` scripts (recon-vs-action, search adoption, per-tool health) at J+30.
Targets: search adoption >= 40 calls/month by the main; zero silent glob misses; browser
< 5%; fetch < 12%.
