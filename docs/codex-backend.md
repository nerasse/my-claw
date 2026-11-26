# Codex Backend (OpenAI ChatGPT subscription)

## Why

Using a ChatGPT Plus/Pro subscription programmatically — running the subscription
models (slugs like `gpt-5.6-sol`, `gpt-5.5`, `gpt-5.4`) without paying per-token API
fees — is only possible through the
same OAuth path the official `codex` CLI uses: an OAuth login against
`auth.openai.com` (public Codex client id `app_EMoamEEZ73f0CkXaXp7hrann`), then
requests to the Codex backend `https://chatgpt.com/backend-api/codex/responses`
authenticated with the OAuth access token as a bearer plus a `chatgpt-account-id`
header extracted from the token JWT.

Unlike the Claude SDK path (`docs/claude-sdk-backend.md`), there is no vendor SDK
to delegate whole runs to: the Codex backend speaks the OpenAI **Responses API**
(`/responses`), not chat/completions. So this is a transport, not an engine — it
plugs into the existing home agent loop.

This is the OpenClaw/Hermes/pi path. Anthropic's ToS explicitly bans it for
Claude; OpenAI's terms are less clear-cut for its own Codex client. Single-tenant,
single-dev deployment: the owner accepts that risk knowingly.

## Decisions

### The model is the single axis; the backend follows from it (unchanged)

- `providers[name].type?: "openai" | "claude-sdk" | "codex"` (default `"openai"`,
  no shims). A `codex` provider has a fixed `baseUrl`
  (`https://chatgpt.com/backend-api`); auth comes from the stored OAuth tokens,
  never from an env API key.
- The resolver carries `backend: "codex"` in `ResolvedLlmConfig`. `models[]`
  freely mixes all three worlds.

### Reuse the home loop; swap only the transport

The Codex backend is **not** a new `AgentBackend`. The `AgentBridge` loop (tool
loop, iteration budget, memory injection, mid-run steering, compaction,
analytics, hooks) is provider-agnostic except for two calls: `chatCompletion` /
`chatCompletionStream`. `AgentBridge` dispatches those to the Codex transport
when `llmConfig.backend === "codex"`. The dispatcher already routes everything
that is not `claude-sdk` to `AgentBridge`, so it needs no change.

`src/llm/codex.ts` exposes `codexResponse` / `codexResponseStream` with the exact
signatures of the chat-completions transport. They convert my-claw `ChatMessage[]`
to Responses `input` items and parse the Responses SSE stream back into the shared
`LlmResponse`. No pi-mono transport code is imported (it is coupled to pi's own
model/context/message types); only the OAuth flow shape is reused.

### Request mapping (chat/completions -> Responses)

- The first `system` message becomes the request `instructions`; any later
  `system` message (e.g. the iteration-limit summary prompt) becomes a `user`
  input item.
- `user` -> `{ role:"user", content }` (string, or `input_text`/`input_image`
  parts for vision).
- `assistant` text -> `{ role:"assistant", content }`; each tool call ->
  `{ type:"function_call", call_id, name, arguments }` (the `id`/`fc_` item id is
  omitted to avoid Responses reasoning-pairing validation).
- `tool` result -> `{ type:"function_call_output", call_id, output }`.
- Tool definitions are flattened from chat form
  (`{type:"function",function:{...}}`) to Responses form
  (`{type:"function",name,description,parameters,strict:false}`).
- Body: `store:false`, `stream:true`, `tool_choice:"auto"`,
  `parallel_tool_calls:true`. Reasoning effort is native: when set it is sent as
  `reasoning:{ effort, summary:"auto" }`. Reasoning is replayed across the calls of one run
  (docs/reasoning-replay.md): `include: ["reasoning.encrypted_content"]` makes the backend hand its
  encrypted state back, and the transport replays it ahead of the calls it produced. The assistant
  item's `phase` rides with it ("The phase the backend labels", below).

### SSE handled

`response.output_item.added`, `response.output_text.delta`,
`response.function_call_arguments.delta/.done`, `response.output_item.done`
(function_call finalize; a message item's `phase` and text; a reasoning item's lifetime times a
thought that came back without a summary), `response.completed`/`.incomplete` (usage,
`reasoning_tokens` included -- docs/reasoning-visibility.md, "A thought with no words"), `error` /
`response.failed`. Non-streaming callers run the same stream with a no-op token sink.

### The phase the backend labels

Assistant message items carry a `phase`: `commentary` for a preamble, `final_answer` for the
closing message. OpenAI's guide is explicit that it must be **persisted and replayed**; without it
the model treats an old preamble as a finished answer and can stop with nothing to say. This
install dropped it for a year and did not read `input_transformations` either, so a backend that
threw away replayed reasoning said so and nobody saw it.

The transport now records the phase on the turn (`providerMeta.phase`, docs/reasoning-replay.md)
and sends it back on the assistant item, to the same backend and model only. A turn that called
tools is replayed as `commentary` whatever the model laboured it; a turn with only prose takes the
phase the backend gave its last non-empty item, and nothing when the backend labelled none (older
models have no such field, and inventing one would be a claim about a turn this model never
wrote).

`input_transformations` is logged as `codex dropped replayed items` with the ids and the reasons
(`prefix_mismatch`, `turn_boundary`, `organization_mismatch`, `model_mismatch`) whenever the
backend removed something. Silent until 2026-11-26, when a replayed history kept shrinking without
a trace.

### An empty final answer

Measured 2026-11-26 on `gpt-6.1-sol`, effort max, a 147k-token conversation: three calls in a row
completed with a `message` item whose `phase` was `final_answer` and whose content was empty, 49 to
72 output tokens billed as reasoning. Nothing was cut, no error was announced, the account was
answering a fresh prompt fine. The model simply closed the turn with nothing in it.

The transport flags it (`emptyFinalAnswer`) only when all of these hold: the response completed,
a `final_answer` item with no text was closed, and the turn carried no prose and no tool call. The
run loop then treats it as the far side's failure -- see docs/provider-failures.md, "An empty final
answer is the far side's failure" -- so the route moves to its next account instead of asking the
same one again.

### Auth: device-code only, stored under my-claw's roof

- Login is the OAuth **device-code** flow (`auth.openai.com/codex/device` + a user
  code). Chosen because the deployment is a headless systemd service on a VPS: no
  browser loopback on `localhost:1455` is practical. Triggers:
  - CLI: `my-claw codex login` (also `status`, `logout`) — via the `myclaw` wrapper
    (`myclaw codex login`) or `bun run <entry> codex login`.
  - In-chat (DM): `/codex login` posts the URL + code and, when a background poll
    confirms approval minutes later, posts a follow-up via `adapter.send` to the
    same chat/thread. `/codex status`, `/codex logout` too.
- Login/logout fire `onAuthChanged("codex")` (wired in `index.ts`), which **auto-creates
  a `chatgpt` codex provider** (`type: "codex", discover: true, group: "ChatGPT (abo)"`)
  in `config.json` if none exists, then re-runs `ModelCatalog.refresh()`. Without
  this, a fresh login would store a token but leave `/model` empty until a restart
  (discovery only runs at boot + every 6h, and is a no-op with no codex provider).
  The provider is written to the **raw** on-disk config (not the runtime-merged
  in-memory config, and not `readConfigFromDisk()` which overlays env secrets), so
  no secret is ever persisted back. The same callback handles Claude
  (`/claude set-token` -> auto-creates a `claude-sdk` provider); see
  `docs/claude-sdk-backend.md`.
- Tokens persist at `$MY_CLAW_DIR/codex/auth.json` (mode `0600`, atomic write):
  `{ access, refresh, expires, accountId }`. `accountId` is decoded from the
  access-token JWT claim `https://api.openai.com/auth.chatgpt_account_id`.
- The transport calls `getCodexAccessToken()` before each request; it refreshes
  via `grant_type=refresh_token` when the token is within the expiry skew, under a
  single in-process guard (single process, so no cross-process lock needed), and
  persists the rotated tokens.

### Cloudflare / originator

The Codex backend sits behind Cloudflare, which challenges non-first-party
originators with `403 cf-mitigated: challenge`. Inference requests therefore send
`originator: codex_cli_rs` and a matching `User-Agent`, plus
`chatgpt-account-id`, `OpenAI-Beta: responses=experimental` — mirroring the real
`codex` client (the Hermes finding).

### Discovery, picker, effort

`codex` providers with `discover: true` list models from
`GET {baseUrl}/codex/models` (best-effort; failure keeps the last known /
curated set, like the OpenAI path). Curated `models[]` entries with
`provider: <codex provider>` work without discovery. Both flow through the
existing `ModelCatalog` -> picker -> `/model` and effort machinery unchanged;
Codex models are effort-native like claude-sdk models.

## Non-goals (this iteration)

- No browser loopback login (device-code only).
- No reasoning-item replay / encrypted reasoning continuity across turns.
- No WebSocket transport (SSE only; pi's `wss` variant is not ported).
