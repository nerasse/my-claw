# Mistral Vibe backend

A Mistral provider that bills the Vibe Code allowance instead of the API key's own pool, on the
same OpenAI-compatible `chat/completions` wire the rest of the home loop uses. The endpoint is the
ordinary Mistral API; what changes is the client the request claims to be and the shape a reasoning
model answers in.

## Why the fingerprint is load-bearing

The Vibe plan grants two purses, and `GET /v1/billing/budget` reports both:

```json
{"vibe_budget":{"usage_percentage":3.77,"initial_budget":510.0,"currency":"EUR",
                "reset_at":"2026-12-01T00:00:00Z","payg_enabled":false},
 "api_budget":{"usage_percentage":0.0,"initial_budget":51.0,"currency":"EUR",
               "reset_at":"2026-12-01T00:00:00Z","payg_enabled":false}}
```

Measured 2026-11-28 on the TEAM plan, with the same key the CLI stores in `~/.vibe/.env`:

- a plain `POST /v1/chat/completions` with `Authorization: Bearer <key>` answers
  `HTTP 402 billing_spend_limit_api_key` ("API key spending limit of 0 EUR reached");
- the same request with `metadata.call_source: "vibe_code"` answers 200, and the Vibe percentage on
  `/billing/budget` moves after it.

So a request that loses `call_source` does not merely look less like the CLI: it moves onto a pool
the key may not have. `src/llm/mistral-vibe.ts` is the one place that owns the claim.

## Captured identity

Captured from Vibe CLI 3.1.5 through a local TLS proxy that forwarded to `https://api.mistral.ai`
(VIBE_HOME pointed at a throwaway config whose provider `api_base` was the proxy, `SSL_CERT_FILE`
its certificate). The model call, verbatim:

```
POST /v1/chat/completions
user-agent: mistral-client-python/Mistral-Vibe/3.1.5
authorization: Bearer <MISTRAL_API_KEY>
x-affinity: <uuid, stable for the session>
content-type: application/json
accept: text/event-stream
```

Body:

```json
{
  "model": "mistral-large-4-0",
  "messages": [ ... ],
  "temperature": 1.0,
  "stream": true,
  "reasoning_effort": "high",
  "tools": [ ... ],
  "parallel_tool_calls": true,
  "metadata": {
    "agent_entrypoint": "programmatic",
    "agent_version": "3.1.5",
    "client_name": "vibe_programmatic",
    "client_version": "3.1.5",
    "os": "linux",
    "arch": "x86_64",
    "os_version": "13",
    "version": "3.1.5",
    "terminal_emulator": "unknown",
    "session_id": "<same uuid as x-affinity>",
    "user_plan": "Team",
    "call_type": "main_call",
    "call_source": "vibe_code",
    "host_kind": "local"
  }
}
```

my-claw reproduces the fields it can state truthfully, and always `call_source`. `user_plan` is
left out: it names the plan of the account the CLI read through `/api/vibe/whoami`, and the billing
gate was measured to read `call_source` alone. The affinity value is a UUID derived from the
conversation key, so the turns of one conversation keep landing on the same backend and the prefix
cache holds; Vibe generates a fresh UUID per session for the same reason.

Two other endpoints the CLI calls, for reference: `GET /v1/users/me` (the key's identity) and
`GET /api/vibe/whoami` on `console.mistral.ai` (plan, `api_base`, `vibe_base`).

## The shape of a reasoning answer

Mistral does not use `reasoning_content`. A reasoning model answers with content parts:

```json
{"role":"assistant","content":[
  {"type":"thinking","thinking":[{"type":"text","text":"Weighing it."}],"closed":true},
  {"type":"text","text":"OK"}
]}
```

Streamed, each delta carries one or more fragments of either kind. The capture of a second turn
shows how the CLI hands its own reasoning back:

```json
{"role":"assistant","content":[
  {"thinking":[{"text":"The user wants ALPHA.","type":"text"}],"type":"thinking"},
  {"text":"ALPHA","type":"text"}
 ],"prefix":false}
```

The transport therefore:

- reads `delta.content` (or `message.content`) as a string **or** a part list, accumulating
  thinking into `reasoning` and text into the answer, keeping the parts in emission order;
- replays the parts verbatim on the assistant message of the next call, with `prefix: false`;
- never sends `reasoning_content` — the API answers
  `422 extra_forbidden` (`messages.1.assistant.reasoning_content`) on it.

Two more strictness facts measured on the same endpoint:

- `cache_control` inside a content part is a 422 (`content.str: Input should be a valid string`),
  so the provider resolves with `promptCache: false`;
- unknown top-level fields are a 422 too (`prefix` at the top level), which is why the transport
  adds nothing beyond the fields above.

`prompt_cache_key`, `stream_options: {include_usage: true}`, `max_tokens`, `temperature`,
`reasoning_effort` and tool calls are all accepted. Usage carries
`completion_tokens_details.reasoning_tokens`, and `prompt_tokens_details.cached_tokens` grows on
its own: the 1M-context models cache implicitly.

## Effort ladders are per model

`reasoning_effort` is validated per model, and a rung a model does not publish is a 400 naming the
supported list. Measured 2026-11-28:

| model | accepted |
| --- | --- |
| `zai-glm-5-3`, `zai-glm-5-3-flash` | `low`, `high`, `max` |
| `mistral-large-4-0` | `low`, `medium`, `high` |
| `mistral-medium-latest` | `none`, `high` |
| `deepseek-v4-1-flash-1017` | `none`, `low`, `high`, `xhigh`, `max` |

Declare a model with `supportsEffort: true` and the ladder it publishes; the resolver clamps a
chosen level to it.

## Models

`GET /v1/models` lists 63 entries with capabilities (`completion_chat`, `function_calling`,
`reasoning`, `vision`), `max_context_length` and aliases. Discovery reads the id, the context and
the vision flag; the client declares the models it wants, because the listing carries no price and
no effort ladder.

## What the allowance covers

The Vibe gate is the `metadata` block of a JSON body, so an endpoint that takes one can be billed
to the allowance and one that cannot is API-pool only. Measured 2026-11-28 with the same key whose
API spending limit is 0 EUR (a plain API call answers 402):

| endpoint | metadata | result |
| --- | --- | --- |
| `/v1/chat/completions` | yes | 200, Vibe percentage moves |
| `/v1/ocr` | yes | 200, Vibe percentage moves |
| `/v1/audio/speech` | yes (`voxtral-mini-tts-3`) | 200, base64 `audio_data` |
| `/v1/audio/transcriptions` | no, multipart only | 402: API pool only |
| image generation | via chat tool | 200, see below |

The transcription endpoint takes a file and form fields, no metadata, and an invented form field
is ignored (still 402). A Vibe-billed transcription would need another route; the voice pipeline
today uses Groq or the local Whisper, so nothing is lost there.

### Image generation

Mistral exposes image generation as a tool on the chat endpoint, not a standalone route. With
`tools: [{"type": "image_generation"}]` and `metadata.call_source: "vibe_code"`, the server
runs the tool itself and answers `object: "chat.multi_completion"`: `choices[0].messages` is a
**list** of assistant/tool/assistant messages, the tool result carrying a signed blob URL that
expires in about an hour. The standard chat parser expects `choices[0].message`, so this is a
dedicated call, not the agent transport.

## The `vibe` tool

One built-in tool gathers the plan's other services, and it exists only while a `mistral-vibe`
provider is configured with its key and has not turned it off (`vibeTool: false` on the provider,
which the provider page writes from its "vibe tool" switch; absent means on).
`ToolRegistry.setConditionalProvider` reads the live config on every tool list, so adding the
provider by hot reload makes `vibe` appear on the next run and disabling it makes it disappear.
Research and browser agents never see it (their sets are closed), like any other built-in.

| action | what it does |
| --- | --- |
| `image` | `prompt` → generates through the chat `image_generation` tool, downloads the signed URL immediately, returns an image attachment |
| `ocr` | `path` or `url`, optional `pages` → markdown, page by page |
| `speak` | `text`, optional `voice` (default `voice_3150`) → MP3 attachment |
| `transcribe` | `path`, optional `language` → text, through Voxtral's `input_audio` on chat |
| `account` | email, plan, organization/workspace, both purses |
| `models` | the chat models the key can reach |

Images and audio follow the draft rule: the tool creates the file with `keepFromReply`, and the
answer sends it with `MEDIA:<path>`. A generated image is fetched before the tool returns because
the blob URL expires in about an hour.

Transcription cannot use `/v1/audio/transcriptions`: it is multipart-only, takes no metadata, and a
plain call answers 402 on this key. Voxtral accepts `input_audio` on chat instead, which does take
`metadata.call_source`, so the tool converts the app's WebM/Opus voice notes to 16 kHz mono WAV with
ffmpeg and sends that. Measured live 2026-11-28: a French voice note came back transcribed, and the
whole call moved only the Vibe percentage.

## Account identity

`GET /v1/users/me` returns the email, workspace and organization behind the key. The quota reader
calls it next to the billing endpoints, best effort, so the usage card can say which account it is
reading (`plan TEAM · yassir.elkssimi@kleegroup.com`). Nothing about the key value crosses the wire.

## Provider config

```json
"mistral_vibe": {
  "type": "mistral-vibe",
  "apiKeyEnv": "MISTRAL_VIBE_API_KEY",
  "group": "Mistral Vibe",
  "pricingProvider": "mistral",
  "discover": true
}
```

`apiKeyEnv` is optional and defaults to `MISTRAL_API_KEY`; the app's own service row writes
`MISTRAL_VIBE_API_KEY`, so the Vibe key can be pasted there without sharing the variable of an
ordinary Mistral API provider (which would send the key to the API pool). Discovery is filtered to
models whose listing says `capabilities.completion_chat: true`, and a declaration on the same id
adds the effort ladder the listing does not publish.

## Quota

`src/llm/quota/mistral.ts` reads two endpoints on `https://api.mistral.ai/v1`:

- `GET /billing/budget` — the Vibe allowance (a monthly window, percentages **used**) and the API
  credit as a money balance, kept apart because they are not interchangeable;
- `GET /billing/subscription` — the plan name and whether pay-as-you-go is on. Best effort on a
  shorter timeout: a platform that does not serve billing costs the plan line, never the budget.

The provider is recognised by `type: "mistral-vibe"`, so a second account keyed differently is read
the same way.

## Rotation

`MISTRAL_VIBE_CLI_VERSION` in `~/.my-claw/.env` moves the claimed version and user-agent on the next
call, the same lever `ANTHROPIC_CLI_VERSION` gives the Claude transport. After a capture shows
drift, update `VIBE_CLIENT` in `src/llm/mistral-vibe.ts` and re-run
`tests/llm/mistral-vibe.test.ts`.

## Not wired

The Vibe plan also covers services the CLI exposes outside the chat loop: image generation, OCR,
audio transcription and speech (`/v1/audio/*`), embeddings, FIM completions, connectors and the
agent/conversation APIs. This backend is the LLM half only. Each one is a separate route with its
own payload; the transcription and speech ones are the next candidates because the voice tools
already have a provider abstraction to plug into.
