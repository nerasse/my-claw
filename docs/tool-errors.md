# The error is the instruction

## Why

Measured over 20-25 November 2026: **15 955 tool calls, 645 failures (4.0 %)**. Most of that is the
work being red on purpose -- 286 of the 297 `bash` failures are `exit code N` from a test, a build
or a grep. The rest is where a call could have gone differently, and the split matters:

| where | failures | what it really was |
|---|---|---|
| `fetch` | 136 / 762 (17.8 %) | a guessed documentation URL answering 404, asked again |
| `web_search` | 26 / 289 (9.0 %) | an empty answer, then the same query retyped |
| `apply_patch` | 40 / 1198 | 5 calls sent `absolute` instead of `path`; the rest are anchors |
| `browser_eval` | 22 / 665 | JS in the page: a stale node, a pending promise |
| `browser_cdp` | 5 / 124 | a method outside an allowlist the description never listed |
| `search` | 16 / 509 | an `rg` that would not start, reported as a failed search |
| `approval` | 3 / 7 | "No channel surface", during a config reload |

146 of the 645 came from three `explorer-research-*` sub-agents on 24 November alone, walking vendor
documentation by guessing paths: 110 `fetch` failures and 26 empty searches. That is not a model
being bad at its job; it is a tool whose answer did not say what to do next.

## The rule

An error message has one job: **change the next move**. "Check the URL, method, and authentication"
was true of every status and therefore changed nothing -- a 404 and a 403 want opposite next steps,
and a model that reads one sentence for both retries the URL that cannot work.

So each refusal names its own way out, and the tool descriptions say the same thing *before* the
failure, because a definition is paid once and an error is paid per attempt.

## What each tool now says

- **`fetch`**, by status: 404/410 "nothing is at this URL, find the page with `web_search` instead of
  guessing another path"; 401/403 "refused, that is not a retry"; 429 "the host is rate limiting";
  anything else "the host answered, a 5xx may pass, a 4xx will not". And a URL that answered 404 or a
  refusal is remembered for ten minutes, so asking it again is answered here instead of at the host.
- **`web_search`** on an empty result: change the query (fewer words, no quotes, a `site:` filter)
  rather than repeating it; fetch the page directly when it is already known.
- **`apply_patch`** without `path`: the answer names the keys the call actually carried, because the
  measured miss was five parallel calls sending `absolute`.
- **`search`**: an `rg` that will not start is not a failed search. The query goes to grep and the
  result carries the fallback banner. Resolution also checks that the binary is a file and can be
  executed, and repairs a mode bit a tar or a copy stripped.
- **`approval`**: the surface is installed at boot and never cleared, so a config reload cannot
  leave a run with no surface at all. `reachable` is read off the live sockets, which is what makes
  "no device connected" the honest answer on a stopped adapter.
- **`browser_cdp`**: the allowlist is in the description, not only in the refusal.
- **`browser_eval`**: the contract is in the description -- await inside the body, never return a
  pending promise, return a serialisable value.

## What is deliberately left alone

- A command that exits non-zero is the answer, not a defect. `exit 1` on a search with no match is
  already a success with a note.
- An anchor that does not match is a patch the caller got wrong; the message already gives the line
  numbers of a duplicate and tells the reader to copy the exact text.
- `write` refusing an existing file is a safety, and its message already names `apply_patch` and
  `overwrite: true`.
- `read` on a path that does not exist is information, not friction.

## The reference agents

`src/agents/builtin/research.md` now says it: reach a page through `web_search` or the site's index,
never by guessing a URL from a pattern; a 404 means the address is wrong and a neighbour almost
certainly is too; an empty search is where the query changes, not where it repeats.
