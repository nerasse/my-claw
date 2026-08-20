# Anthropic backend

A native Anthropic Messages transport on the home loop, so the Claude subscription
stops needing an engine of its own. The end state is the removal of
`docs/claude-sdk-backend.md`: one loop, three transports (`openai`, `codex`,
`anthropic`), and no second agent runtime to maintain.

## Why

The Claude Agent SDK backend works, but it is an engine, not a transport. It owns
the loop, the history, the compaction, the caching and the tool plumbing, which
means every feature of the home loop has to be built twice or skipped on Claude.
The subscription is the only reason it exists, and the subscription does not need
it: `claude setup-token` mints a token that `/v1/messages` accepts directly.

What we gain: the home loop's tools, prompt, pruning, iteration budget, hooks and
per-call analytics on Claude models; versioned models with per-model effort (the
SDK only exposes the moving `opus`/`sonnet`/`haiku` aliases); streamed thinking
instead of redacted thinking; one npm dependency less.

What we take on: prompt caching becomes our job (see [Caching](#caching)), and so
does request fidelity (see [Fidelity](#fidelity)).

## End state

| Piece | Today | After |
| --- | --- | --- |
| Provider key | `claude-sdk` | `anthropic` |
| `providers[].type` | `claude-sdk` | `anthropic` |
| Engine | `ClaudeSdkBackend` | home loop (`AgentBridge`) |
| Transport | SDK subprocess | `src/llm/anthropic.ts` |
| Credential | `sk-ant-oat` via `loadClaudeToken()` | unchanged |
| `/claude` command | token store | unchanged |
| `claude` CLI | runtime dependency | `setup-token` only, once a year |

`claude-auth.ts` and `/claude` survive on purpose: they own the credential, not
the engine. That is why the provider was keyed `claude-sdk` in 0.4.14 rather than
`anthropic` -- the name of the thing that disappears disappears with it.

## Auth

`loadClaudeToken()` already resolves the token (my-claw's own file first, then
`CLAUDE_CODE_OAUTH_TOKEN`). No refresh, no PKCE, no rotation, no cross-process
lock: a `setup-token` credential is valid for about a year and is replaced by
hand. The transport sends `authorization: Bearer <token>` and never `x-api-key`.

Measured 2026-08-19: a bare `POST /v1/messages` carrying only `authorization` and
`anthropic-version` returns 200, with `anthropic-ratelimit-unified-*` response
headers (the subscription bucket family) and `usage.service_tier: standard`.
Request id `req_011CeCUYfFLG6irJgsaYTAx2`. The same held with my-claw's real
9 KB system prompt, with the documented `Here is some useful information about
the environment you are running in:` trigger phrase, and with five lowercase
snake_case tools.

That measurement says the auth is sufficient for a 200. It says nothing about
detection, so it is not a licence to send bare requests. See below.

## Fidelity

Normative. The objective is not "obtain a 200", it is "be indistinguishable from
the Agent SDK this transport replaces". my-claw runs
`@anthropic-ai/claude-agent-sdk` 0.3.223 today, and the identity string below is
already the first line of every system prompt it sends, so presenting as
`sdk-cli` is a description rather than a disguise.

Nothing here is guessed from a community project. P0 captured the real client on
this box (`claude` 2.1.206, the binary the SDK spawns) through a local logging
proxy, and this is what it sends. Where a community implementation disagrees with
the capture, the capture wins.

`POST /v1/messages?beta=true` -- the query parameter is part of the shape.

```
authorization:                             Bearer <sk-ant-oat...>
anthropic-version:                         2023-06-01
anthropic-beta:                            oauth-2025-04-20,
                                           interleaved-thinking-2025-05-14,
                                           thinking-token-count-2026-05-13,
                                           context-management-2025-06-27,
                                           prompt-caching-scope-2026-01-05,
                                           claude-code-20250219,
                                           advisor-tool-2026-03-01,
                                           extended-cache-ttl-2025-04-11
anthropic-dangerous-direct-browser-access: true
user-agent:                                claude-cli/2.1.206 (external, sdk-cli)
x-app:                                     cli
x-claude-code-session-id:                  <uuid, stable per process>
x-stainless-arch:                          x64
x-stainless-lang:                          js
x-stainless-os:                            Linux
x-stainless-package-version:               0.94.0
x-stainless-retry-count:                   0
x-stainless-runtime:                       node
x-stainless-runtime-version:               v26.3.0
x-stainless-timeout:                       600
accept:                                    application/json
accept-encoding:                           gzip, deflate, br, zstd
content-type:                              application/json
x-api-key:                                 absent, never sent beside a bearer token
```

Eight betas, in that order, not two. `x-app`, `x-claude-code-session-id`, the
eight `x-stainless-*` and `anthropic-dangerous-direct-browser-access` are all
part of the real request: an earlier draft of this document proposed omitting
them because the reference plugin omits them, which the capture disproves.

`x-stainless-runtime-version` reports the Node the CLI bundles (v26.3.0). my-claw
runs Bun, so this value is pinned rather than read from `process.version`.

Body fields beyond the obvious, all present in the capture:

```json
{
  "metadata": { "user_id": "{\"device_id\":\"<sha256>\",\"account_uuid\":\"<uuid>\",\"session_id\":\"<uuid>\"}" },
  "thinking": { "type": "enabled", "budget_tokens": 31999, "display": "omitted" },
  "context_management": { "edits": [{ "type": "clear_thinking_20251015", "keep": "all" }] },
  "stream": true
}
```

`thinking.display: "omitted"` is why the SDK backend can only report a thinking
token count. Streaming the text means departing from the capture on that one
field, which is a deliberate, documented divergence rather than an oversight.

`system[]` layout, exactly three blocks:

1. The billing header block, `{ type: "text", text: <string below> }`, with **no**
   `cache_control`.
2. `You are a Claude agent, built on Anthropic's Claude Agent SDK.` as its own
   block, **with** `cache_control: { type: "ephemeral", ttl: "1h" }`.
3. The rest of the system prompt, **with** `cache_control: { type: "ephemeral", ttl: "1h" }`.

Billing header string, transcribed from the CLI's own bundle rather than from a
community reimplementation (`WLn`, `qxu`, `OHg`, `OYi` in claude 2.1.206, a
greppable 247 MB single-file bundle at `~/.local/share/claude/versions/<v>`):

```js
function OHg(entries) {            // pick the text to sample
  const t = entries.find((n) => n.type === "user" && !n.isMeta);
  if (!t) return "";
  const r = t.message.content;
  if (typeof r === "string") return r;
  if (Array.isArray(r)) { const n = r.find((o) => o.type === "text"); if (n) return n.text; }
  return "";
}
function OYi(text, version) {      // the three-char suffix
  const n = [4, 7, 20].map((s) => text[s] || "0").join("");
  return sha256("59cf53e54c78" + n + version).slice(0, 3);
}
function WLn(suffix, ctx, prevReqId) {
  if (truthy(process.env.CLAUDE_CODE_ATTRIBUTION_HEADER)) return "";
  const cch = (kind === "firstParty" && Ud()) || kind === "vertex" ? " cch=00000;" : "";
  return `x-anthropic-billing-header: cc_version=${VERSION}.${suffix}; ` +
         `cc_entrypoint=${process.env.CLAUDE_CODE_ENTRYPOINT ?? "unknown"};${cch}` +
         `${workload}${isSubagent}${prevReq}`;
}
```

So the salt, the sampled positions `[4, 7, 20]` and the 3-char slice are right,
and three things an earlier draft of this document had wrong:

* **`cch` is not a hash.** It is the literal string `00000`, and it only ships on
  the first-party and vertex paths. A subscription request carries no `cch` at
  all. The four community plugins all compute `cch = sha256(text)[:5]`, which is
  their invention; theirs are accepted, but they are not what the client sends.
* **The sampled text skips meta entries.** `OHg` filters `!isMeta`, which on the
  wire means skipping the `<system-reminder>` blocks. Sampling the first block of
  the first user message yields `f9a` where the real client sent `ca4`.
* **The header is always emitted.** `OYi` defaults each missing character to
  `"0"`, so an empty prompt produces a real suffix, not a missing header.

Three optional fields exist and none apply here: `cc_workload=<w>` (set inside a
cron workload), `cc_is_subagent=true` (a non-main agent context), and
`cc_prev_req=<id>` (first-party only). `CLAUDE_CODE_ATTRIBUTION_HEADER` disables
the header outright, and `cc_entrypoint` is read from `CLAUDE_CODE_ENTRYPOINT`,
which the SDK sets to `sdk-cli`.

Verified end to end: driving the real CLI with `Read the file
/tmp/capture/hello.txt and tell me what is in it` produced
`cc_version=2.1.206.ca4`, and the transcribed algorithm reproduces `ca4` exactly.
`tests/llm/anthropic.test.ts` pins that vector.

Tool naming reproduces what my-claw's own SDK path already sends, not what the
bare CLI sends. The capture shows the CLI declaring its 29 native tools in bare
PascalCase (`Agent`, `Bash`, `Read`, `Write`), with **no** `cache_control` on any
of them. my-claw's tools reach the SDK through an in-process MCP server named
`myclaw`, so they go out as `mcp__myclaw__<tool>`, and that is the shape with a
track record on this account (7524 calls in seven days). The transport keeps it.

The community `mcp_` plus PascalCase convention (`bash` -> `mcp_Bash`) exists to
make a third-party harness's tools look like MCP tools. my-claw's already are,
so the rewrite is unnecessary here.

`ANTHROPIC_CLI_VERSION` and `ANTHROPIC_USER_AGENT` override the two drifting
values, both derived from a single resolver so the user-agent version and
`cc_version` can never disagree.

### On the version, and why the capture overrules the survey

Four community implementations pin four different values (2.1.87, 2.1.160,
2.1.206, 2.1.217) and two different user-agent suffixes, and all four work. That
survey suggested the field is loosely validated, and this box confirms it: it has
been sending `2.1.87` since 2026-06-28 through
`@ex-machina/opencode-anthropic-auth` 1.8.1 with no incident in seven weeks.

The capture then answered the question the survey could not. The real client sends
**the version of the CLI it is**, `2.1.206` here, in both the user-agent and
`cc_version`, with the suffix `(external, sdk-cli)`. So the rule is not a pinned
constant at all: read `claude --version` once at boot, fall back to a pinned
`2.1.206`, and let it track the CLI that mints the token anyway. A hardcoded
2.1.217 would claim a version this machine does not have.

The invariants, unchanged by any of this: the salt, the sampled positions, the
`sdk-cli` entrypoint, the beta list, and the three-block `system[]` layout.

## Long context

Not optional, and not a corner case. Measured over 7 days on the SDK backend
(`api_calls`, 7524 calls): **42 % of requests exceed 200 000 input tokens**, and
the largest was **565 807**. The configured cap is `llm.limit.context: 430080`.

So the transport ships past the standard window from its first day, on a plan that
already covers it today. Two consequences:

* Whatever the SDK sends to get there (a beta flag, a header, or nothing at all
  now that 1M is native) is a P0 capture question, not a guess. `griffinmartin`
  reports the legacy `context-1m-2025-08-07` flag is no longer required and that a
  long-context failure surfaces as `Extra usage is required for long context
  requests`.
* A cache miss on a 500 000-token prompt is not a rounding error. This is the same
  finding as the section below, seen from the other end.

## Caching

The consumption gate, and the hardest part of the port.

Measured over 48 h on the SDK backend (`api_calls`, 3292 calls): 626 427 600
input tokens, of which 603 255 117 cache reads (**96.3 %**), 23 162 462 cache
writes, about 10 000 fresh. Output over the same window: 52 557. The workload is
input-bound by four orders of magnitude, and the SDK places its `cache_control`
breakpoints itself.

A transport that places them badly turns 603 M cache reads into fresh input for
identical work. That is roughly ten times the plan consumption and ten times the
volume visible upstream, with no test failing and no error surfacing.

Rules, taken from the capture rather than inferred:

* At most 4 `cache_control` blocks per request. The billing header never carries one.
* The real client places **two** breakpoints, both `{ type: "ephemeral", ttl: "1h" }`:
  one on the identity block, one on the system prompt block. The 1h TTL is what
  the `extended-cache-ttl-2025-04-11` beta buys.
* **No `cache_control` on tool definitions.** The tools ride inside the prefix the
  system breakpoints already cover.
* That leaves two of the four slots free for turn boundaries.
* **Nothing per-request may land before the last breakpoint.** Recalled memories,
  the current date, live context notes and platform hints change on every turn; in
  the cached prefix each one invalidates the whole prefix. They belong in the
  current user turn.
* `context-pruning.ts` rewrites older tool results. Any edit before a breakpoint
  invalidates everything after it, so on this transport pruning either runs only
  behind the last breakpoint or is disabled. This is a conflict to resolve in P1,
  not a detail to discover from the bill.
* `providers[].promptCache` is documented as opt-in for OpenAI-compatible
  providers and ignored on `claude-sdk`. On this transport caching is not optional,
  so the flag is ignored here too and the breakpoints are always placed.

## Transport

`src/llm/anthropic.ts`, patterned on `src/llm/codex.ts` (408 lines, the existing
precedent for a non-OpenAI transport on the home loop). The home loop stays
provider-agnostic except for the two call sites in `src/agent/bridge.ts` (lines 63
and 74) that already choose between the Codex and OpenAI transports.

Work items:

* `ChatMessage[]` to Anthropic content blocks: `text`, `image`, `tool_use`,
  `tool_result`, `thinking`. `system` leaves the message array.
* Strict `tool_use` / `tool_result` adjacency, and an assistant turn carrying
  non-`tool_use` content after a `tool_use` gets split.
* SSE stream to tokens, tool calls, thinking deltas and usage, buffered at event
  boundaries so the tool-name mapping is never applied to a partial name.
* `effort` per model, from the levels `anthropic-models.ts` already discovers.
* Retry on 429 and 529 with `retry-after`, reusing the existing policy.

Tool naming lives **strictly at the transport boundary**: nothing above
`anthropic.ts` ever sees a prefixed name, so `toolDisplayName`, the session mirror
and the app's tool cards are untouched. Note the two schemes are unrelated: the
SDK sees my-claw's tools through an in-process MCP server and calls them
`mcp__myclaw__<tool>`, while this transport declares them directly and maps
`bash` to `mcp_Bash` on the wire only.

Already in place, no work: the credential (`claude-auth.ts`), model discovery
(`fetchAnthropicModels` over `/v1/models`, versioned ids, per-model effort,
context windows), the resolver's provider plumbing, the tool loop, the local
compaction summarizer including auto-compaction (`autoCompactEnabled`,
`bridge.ts`), and per-call analytics.

Two behaviours are SDK-only today and need a decision in P1:

* `providers[].fallbackModel`, an automatic failover the resolver only emits on
  the `claude-sdk` branch. Keep it for `anthropic`, or drop it and rely on the
  dispatcher's outage reroute.
* Reasoning visibility. `ReasoningSink` has two shapes because the SDK redacts
  thinking and only reports a token count. This transport streams the text, so
  the app receives `onText` where it received `onTokens`, and `onTokens` is left
  to the bridge (see "The token count is not reported").

Analytics needs nothing either: `api_calls` records `base_url` as an engine
sentinel and `model` as the bare wire id, so cost attribution is untouched by the
new provider. Keep `ENGINE_PROVIDER` in `src/llm/pricing.ts` mapping the old
`claude-sdk` sentinel to `anthropic` until the 90-day retention ages the rows out.

## Phases

Each phase ships on its own and is reversible.

### P0 -- capture ground truth (done, 2026-08-19)

No mitmproxy, no CA to trust, no TLS interception: `ANTHROPIC_BASE_URL` accepts a
plain HTTP URL, so a 50-line Bun reverse proxy logs the request and forwards it
upstream. It redacts the bearer token before writing, so the capture is safe to
commit. The running service was never touched: the capture drove the `claude`
binary directly, which is the same client the SDK spawns.

Everything in [Fidelity](#fidelity) and the breakpoint placement in
[Caching](#caching) comes from that capture. Two things it did not settle:

* A turn above 200 000 input tokens, where the header set may differ. 42 % of real
  traffic is in that range.
* my-claw's own SDK traffic rather than the bare CLI's: the headers and the
  `system[]` shape are the SDK's either way, but the tool list and the prompt body
  are the CLI's here. Capturing my-claw itself needs the service restarted behind
  the proxy, so it waits for a window with no run in flight.

Rationale: the four community projects reverse-engineered Claude Code from the
outside. This box runs the real client, so the target is a diff against ground
truth rather than a copy of somebody's constants. P0 settles headers, beta list,
`system[]` layout and cache breakpoint placement in one pass, and it is the only
step that can prove the constants above are right.

Exit: a redacted capture of one real SDK turn with tools, committed.

### P1 -- transport, coexisting (done, 2026-08-19)

New provider type `anthropic`, new provider key `anthropic`, `src/llm/anthropic.ts`,
two lines in `bridge.ts`, the resolver branch, and the type union everywhere it is
redeclared rather than imported: `core/config.ts` (twice, the config field and
`ResolvedLlmConfig.backend`), `core/config-edit.ts` (`ProviderPatch.type` and
`PROVIDER_TYPES`), `channels/my-claw-app/types.ts`, plus the app's
`core/protocol.ts`, `AppShell.tsx` and `ProviderEditScreen.tsx`. Default stays on
the SDK. Resolve the pruning conflict and the two P1 decisions here.

No `apiKey` on this branch: like `codex`, the transport fetches the credential
itself, and `x-api-key` is never sent next to a bearer token.

Exit met. Two live haiku requests through the transport: the model called `read`,
the id and the reassembled arguments came back, the tool result was accepted and
answered. Both 200, both carrying `anthropic-ratelimit-unified-*` with
`representative-claim: five_hour`, which is the subscription counter rather than
the API-key one.

Two faults only the live calls could surface:

* `context_management.clear_thinking_20251015` sent without an enabled `thinking`
  block is a 400, `strategy requires thinking to be enabled or adaptive`. The real
  client never meets it because it always thinks; a model with no effort level
  does. The two fields now ship together or not at all.
* A `cache_control` breakpoint below the model's minimum cacheable length (1024
  tokens, 2048 on Haiku) is ignored **silently**: usage reports zero on both
  buckets, with no error and no warning. The first live test had a 60-byte system
  prompt and therefore measured nothing while looking like a success. Re-measured
  above the floor, on a 28 789-byte system prompt: write `prompt=6829
  cacheWrite=6816 fresh=13`, then read `prompt=6829 cacheRead=6816 fresh=13`.
  99.8 % on the second identical call, which proves the breakpoints place a real
  entry, that the prefix survives across calls, and that the usage folding is right.

### P2 -- parity gates

Three criteria, all measured, none subjective:

1. Payload byte-identical to the P0 capture, the prompt body excepted.
   **Automated: `tests/llm/anthropic-capture-parity.test.ts`** reads the committed
   artifact and compares arity, breakpoint placement, the billing block's byte
   length, the beta list and its order, `thinking`, `context_management`,
   `max_tokens`, `stream`, and the header set. The one deliberate divergence
   (`metadata` dropped) is asserted as a divergence so it stays a decision.
2. Cache read ratio at or above 95 %, measured in `api_calls` against the 96.3 %
   baseline, over a day of real use. **Blocked on elapsed time, not on work.** The
   99.8 % above is a synthetic pair, not a day of traffic.
3. Zero 400 over that same day. Same gate: needs the day.

Exit: all three green on a week of daily use with the SDK still available.

### P3 -- flip the default

`defaultModel` and `defaultProvider` move to the native provider. The SDK stays
installed and reachable through `/model` as the rollback.

Exit: a week with no reason to switch back.

### P4 -- remove the SDK

The shrink. Delete `src/agent/claude-sdk/` (6 files, 1674 lines), the dispatcher's
engine branch (`BackendDispatcher` becomes a transport chooser), `history.ts`, the
SDK path in `/compact`, the session fields `sdkSessionId`, `sdkSyncedAt` and
`sdkTranscriptBase`, the `claude-sdk` member of the provider type union in both
repos, `$MY_CLAW_DIR/claude-sdk/`, the `@anthropic-ai/claude-agent-sdk`
dependency, and `docs/claude-sdk-backend.md`.

Three call sites outside the SDK directory depend on it and break if the folder
goes first:

* `subagents/runner.ts` imports `ClaudeSdkBackend` and picks the engine per
  resolved model (line 400), exactly like the dispatcher.
* `channels/session-instructions.ts` and `channels/introspect-commands.ts` both
  import `OWNER_STEERING_NOTE` **from the SDK backend** and branch on
  `backend === "claude-sdk"`. That constant has to move to a neutral module, and
  P1 decides whether the native transport wants the same note (mid-run injection
  works differently outside the SDK).
* The session `backend` field reaches the app as a plain `string`
  (`channels/my-claw-app/types.ts:1744`), so no wire type breaks, but the value
  changes and the app's `sessionInstructions` fixture asserts on `'claude-sdk'`.

The union goes from `openai | claude-sdk | codex` to `openai | anthropic | codex`,
same arity, so the app's provider screen keeps its shape and only the literal
changes. Server and app ship together.

Threads whose history lives only in an SDK transcript are the one data question:
either they are migrated by replaying local history (the mechanism `history.ts`
already implements, in the direction that already works) or they are left to the
local history, which is authoritative anyway.

## Risks

| Risk | Mitigation |
| --- | --- |
| Cache placement regresses consumption silently | P2 gate 2, measured against a recorded baseline |
| Anthropic tightens validation on a pinned field | `ANTHROPIC_CLI_VERSION` and `ANTHROPIC_USER_AGENT` env overrides, no release needed |
| Fidelity drift after an SDK upgrade | Re-run the P0 capture and diff; it is a repeatable script, not a one-off |
| Volume, the actual ban vector named by the reference project's own README | The cache ratio is also the volume metric; P2 gate 2 covers both |
| A 500 k-token request fails past the standard window | P0 captures a long-context turn before any code is written |
| A thread stranded in an SDK transcript | P4 migration by local-history replay |

## Artifacts

* `docs/captures/claude-cli-2.1.206.json` -- the P0 capture, redacted. Bearer
  token, `device_id` and `account_uuid` removed; prompt bodies and tool schemas
  reduced to their shape.
* `scripts/capture-anthropic-proxy.ts` -- the logging proxy. Run it, point
  `ANTHROPIC_BASE_URL` at `http://127.0.0.1:8899`, drive any Anthropic client
  through it. Re-runnable after an SDK upgrade, which is how fidelity drift gets
  caught rather than assumed.

## Rollback

Per phase: P1 and P2 are additive, P3 is one config edit, P4 is a revert plus a
reinstall of the npm dependency. The credential never moves, so no rollback ever
touches auth.

## Open questions

1. Pruning on the Anthropic transport: disable it, or restrict it to behind the
   last cache breakpoint? Decides in P1.
2. `metadata.user_id`. The real client sends a JSON blob carrying a stable
   `device_id`, the `account_uuid` and the session id. No community
   implementation reproduces it, and ex-machina has seven clean weeks without it,
   so omitting is proven safe. Reproducing it means sourcing two identifiers from
   the CLI's own state. Fidelity against coupling.
3. `thinking.display`. The capture sends `"omitted"`, which is exactly what makes
   the SDK redact thinking. Streaming the text means diverging from the capture on
   that field. Accept the divergence, or keep thinking redacted and lose the gain?
4. `context_management.edits` with `clear_thinking_20251015`. Server-side thinking
   trimming that the home loop does not know about. Send it as captured, or leave
   it out and let local pruning do the work?
5. `fallbackModel` on `anthropic`: keep the SDK's per-provider failover, or rely
   on the dispatcher's outage reroute alone?
6. `OWNER_STEERING_NOTE` on this transport: same note, a different one, or none?
7. P4 timing for the app release, since the union change is a breaking wire
   change that must ship in lockstep.

Answered by P0, kept here for the record: the beta list is the eight flags of the
capture, not ex-machina's two; the user-agent suffix is `(external, sdk-cli)`;
`x-stainless-*`, `x-app` and `x-claude-code-session-id` are all part of the real
request; tool definitions carry no `cache_control`.

## Subscription auth: two credentials, one file

`~/.my-claw/claude/auth.json` (0600) holds both kinds, and `loadClaudeToken()` is the only reader:

| field | source | life | refresh |
|---|---|---|---|
| `oauth` | `/claude login` (PKCE, code pasted back) | ~8 h | in place, before expiry |
| `token` | `claude setup-token` in a terminal, or `/claude set-token` | ~1 year | none |

Order: `oauth` first, then `token`, then `CLAUDE_CODE_OAUTH_TOKEN`. The fallback also runs on a
**failed** refresh, which is the reason for keeping both: a refresh outage degrades to the long-lived
token instead of stopping every run. Pasting a token clears the OAuth credential, because a paste is
a choice of which authentication to use and a silently outranked paste looks like a bug.

The client id, both endpoints and the scope string come out of the shipped CLI bundle, not out of a
community plugin: `9d1c250a-e61b-44d9-88ed-5944d1962f5e`,
`https://platform.claude.com/oauth/authorize`, `https://platform.claude.com/v1/oauth/token`,
and `user:profile user:inference user:sessions:claude_code user:mcp_servers`. The plugins add
`org:create_api_key` and `user:file_upload`, which this flow does not use.

The CLI's own login redirects to a localhost listener, which needs a browser on the same host. The
chat flow uses the manual variant the same page serves (`code=true`): Anthropic displays the code and
the owner sends it back with `/claude code <code>`. The verifier and the state stay in memory for
10 minutes and never touch the disk. `/claude code` is masked in the command log: an authorization
code is exchangeable for a refresh token until it is spent.

One in-process guard collapses concurrent refreshes. A rotation that omits the new refresh token
keeps the old one, because dropping it would throw away the only way back in.

## It is a provider, not a special case

Three things separated it from a plain litellm provider, all closed.

**Compaction and memory consolidation used to refuse it.** Both callers forced their model onto a
chat-completions one, so a 1M-context Opus session was summarized by whichever model sat at the top
of `config.models`. The dispatch moved into `src/llm/transport.ts` (`llmComplete`,
`llmCompleteStream`), the agent loop, the summarizer, the consolidation pass and the browser
sub-agent all go through it, and the resolver's guarantee changed from "speaks chat-completions" to
"has an HTTP transport at all". Only `claude-sdk` still borrows another model, because it is a
subprocess owning its own session and there is no request to send. Measured on the live config:

```
anthropic/claude-opus-5     run=anthropic   compaction=anthropic   anthropic/claude-opus-5
claude-sdk/claude-opus-5    run=claude-sdk  compaction=anthropic   anthropic/claude-opus-5
chatgpt/gpt-5.6-luna        run=codex       compaction=codex       chatgpt/gpt-5.6-luna
```

The borrowing order lives in `src/llm/utility-model.ts` and prefers, in this order:

1. **The native twin**, the same wire id under a provider of type `anthropic`. Same model, same
   subscription, so an SDK Opus session is summarized by Opus. The `opus`/`sonnet` aliases are
   resolved server-side by the SDK and appear in no `/v1/models`, so they have no twin and fall
   through rather than being guessed at.
2. **The default's twin**, which is what an alias pin inherits.
3. **The default model**, the one model the owner actually picked.
4. **Declaration order**, which is what is left when none of the above applies.

Every candidate must be *runnable*, not merely declared: a provider that answered and did not list
the id has testified that it is gone (docs/model-resolution.md). Declaration order alone was the
whole policy until 0.4.19, and both halves of that hurt on the live config: the entry at the top was
a local 35B, and it had been renamed on the gateway months earlier, so every SDK-session compaction
resolved to a model that answered HTTP 400.

**The circuit breaker was chat-completions only.** One breaker per endpoint lives in `provider.ts`,
and both subscription transports now call the same three helpers. A subscription outage used to be
retried three times on every single turn for as long as it lasted; it now opens the breaker like any
other dead endpoint.

**Discovery reported a network fault instead of a config one.** A provider with no `baseUrl` reached
fetch as the relative `/models`, which answers `TypeError [ERR_INVALID_URL]: fetch() URL is invalid`
and names nothing. It happens for real: a config naming a provider type the running build does not
know falls through to the openai branch, which is exactly how an `anthropic` entry looked like a
network error on the build before the one that understood it. It now names the provider and the
missing field.

## Reasoning is shown, which is the one field we differ on

The captured client sends `thinking.display: "omitted"`: the thinking block comes back with an empty
text field and only `usage.output_tokens_details.thinking_tokens` says the model reasoned at all.
Reproducing that made this backend the only engine in my-claw whose reasoning never reached the chat,
while the Codex transport streams its own through the same sink.

So the transport asks for `display: "summarized"`, and thinking arrives as `thinking_delta` events
that feed `ReasoningSink.onText` exactly as `response.reasoning_text.delta` does on Codex. Measured
through the real transport on Haiku 4.5:

```
texte      : "24 divise par 8 egale **3**. (Verification: 8 x 3 = 24)"
reasoning  : "L'utilisateur me demande de penser puis de lui dire le resultat de 24 divise par 8..."
```

Two things this cost, both accepted: the first text token arrives later, since skipping thinking
tokens is the documented point of `"omitted"`, and the reasoning text crosses the wire. Nothing else
changes. The thinking happens and is billed either way, which one prompt on one model shows directly:
`"omitted"` returned `{thinking_tokens: 57}` with no text, `"summarized"` returned 54 with the text.

`ANTHROPIC_HIDE_THINKING=1` restores the captured shape without a rebuild.

**Naming the field is the whole point.** Leaving `display` out is not neutral: `omitted` is already
the default on Opus 5, Sonnet 5, Fable 5 and Opus 4.7/4.8, so an absent field returns empty thinking
blocks on exactly the models that matter.

### The token count is not reported, and that is not an oversight

`usage.output_tokens_details.thinking_tokens` is read off the stream and dropped.
`ReasoningSink.onTokens` exists for the SDK bridge, which reports a running estimate **while** the
model thinks: the count opens the bubble that the answer then fills, and it is the only trace a
redacted turn leaves. Neither property holds here.

The count arrives on `message_delta`, the last event of the stream, so it lands *after* the answer.
The app's streamer seals a bubble that already holds visible text before any reasoning
(`sealBeforeReasoning`), so the count opened a **second** bubble reading `Thought . 14 tokens`,
under a reply whose reasoning was already displayed in full above it. Worse, the mirror stores no
`reasoningTokens` for this transport, so the stray bubble vanished on the next reopen of the thread:
the live stream and the replay disagreed, and the replay was the correct one.

So this transport reports thinking as text, and only as text. Under `ANTHROPIC_HIDE_THINKING=1`
there is no text and nothing is reported: a turn's thinking is then invisible in the app, which is
what asking for `omitted` means. The tokens are still billed and still counted in `output_tokens`,
so `/status` and the analytics are unaffected either way.

## Thinking off: it exists, per model, and it is not discoverable

`thinking: {type: "disabled"}` is real. Three constraints, all measured on the wire:

```
opus-5   disabled + effort xhigh  -> 400 output_config.effort 'xhigh' is not supported when
                                        thinking is disabled on this model. Use effort 'high' or below
opus-5   disabled + display       -> 400 thinking.disabled.display: Extra inputs are not permitted
fable-5  disabled                 -> 400 "thinking.type.disabled" is not supported for this model
opus-5   disabled + effort low    -> 200
```

The first error is itself the proof that Opus 5 accepts the mode: it complains about the *effort*,
where Fable 5 complains about the *mode*.

`/v1/models` does not say which models accept it. `capabilities.thinking.types` reports only
`adaptive` and `enabled`, so support for being told not to think is invisible there, and it differs
inside one generation (Opus 5 yes, Fable 5 no). A hardcoded list would be wrong the day the next
model ships, so the transport **learns**: the first `thinking.type.disabled` refusal per model per
process is remembered and the request is replayed with thinking left on. Measured: one 400, one log
line, then a 200 on the same turn.

How it is exposed: discovery prepends a `none` rung to the ladder of every model that has thinking
to turn off, because my-claw shows one ladder and the API has two parameters. `none` is **never**
sent as an effort value (`output_config.effort: Input should be 'low', 'medium', 'high', 'xhigh' or
'max'`); it becomes the thinking block, and the effort riding with it is the floor of the published
ladder, which is also what the Opus 5 ceiling would force.

**The caveat that matters here more than anywhere.** Anthropic documents that with thinking off,
Opus 5 "can occasionally emit tool calls as plain text or include internal XML tags in its visible
output". In an agent loop that is silent breakage: the model narrates the tool call and nothing runs.
The transport logs a warning once per model when `none` rides with tools. Prefer `low` over `none`
for any turn that needs tools.

## Effort is validated per model, not per family

`/v1/models` publishes a ladder per model and the API enforces it:

```
claude-opus-5      low medium high xhigh max      thinking: adaptive
claude-sonnet-4-6  low medium high max            thinking: adaptive + enabled
```

Asking Sonnet 4.6 for `xhigh` is `HTTP 400 This model does not support effort level 'xhigh'.
Supported levels: high, low, max, medium.` So the ladder rides on the resolved config
(`effortLevels`, straight from discovery) and the transport clamps against it, with the five-rung
union as the fallback for a model whose ladder was never read. my-claw's own vocabulary is wider than
the API's: `none` and `minimal` clamp to `low`, `ultra` clamps to `max`. Dropping the field instead
would land on the API default, which is `high`, so a request for the least would get nearly the most.

Measured live, all rungs answering 200: five on Opus 5, and seven asked of Sonnet 4.6 (four of its
own plus `xhigh`, `ultra` and `minimal`, which clamp).
