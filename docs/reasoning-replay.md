# Reasoning Replay

## Why

An agent loop calls a tool, gets a result, and calls the model again. What the model was *thinking*
when it decided to make that call is, on most transports, thrown away between the two. It arrives
at iteration N+1 holding the tool outputs and no record of why it asked for them, and re-derives
its plan from the outputs alone. Every iteration.

Measured on this install, median iterations to finish a comparable task:

| model | transport | median iterations |
| --- | --- | --- |
| opus | anthropic | 19 |
| gpt-5.4 | codex responses | 8 |
| gpt-5.6-luna | `opencode_go` chat-completions | 68 |
| luna | codex responses, no replay | **142** (ceiling 512) |

The same model over two transports differs by a factor of two, so the model is not the variable.
And the wandering is not repetition: exact duplicate tool calls were **0 %** on the luna runs
against 1.3 % on opus. It does not loop, it drifts — the signature of a planner that keeps losing
its plan.

The Responses API only keeps the chain of thought server-side when `store: true`. We send
`store: false`, correctly, so the state has to make the round trip through us or not exist.

## What is replayed

### OpenAI Responses (`codex.ts`)

- The request sends `include: ["reasoning.encrypted_content"]`. Without it the reasoning items are
  still announced on the stream but carry no state, and replaying an empty one buys nothing.
- `response.output_item.done` with `item.type === "reasoning"` yields `{ id, encrypted_content }`.
  `done` and not `added`: the encrypted state is only complete once the item closes.
- The terminal `response.completed` is read as well, and backfills any item whose encrypted state
  was missing. It is not guaranteed on the item: Azure's OpenAI deployments omit it there and supply
  it only in the completed response, and an item replayed without it is dropped as unusable.
- `buildInput` emits `{ type: "reasoning", id, summary: [], encrypted_content }` **ahead of** the
  `function_call` items of the same assistant turn. The order is load-bearing — the API rejects a
  reasoning item that does not precede the call it produced.

### Anthropic (`anthropic.ts`) — on by default

Anthropic documents this as mandatory, not advisory:

> **Required:** within a tool-use turn, pass thinking blocks back. [...] you **must** pass the
> thinking blocks from the assistant message back to the API, complete and unmodified.

Omitting them fails the request with `thinking or redacted_thinking blocks in the latest assistant
message cannot be modified`. Outside a tool-use turn the docs explicitly allow omitting them, which
is why this only ever applies inside the loop.

- Thinking blocks are stitched from three events — `content_block_start` opens the block,
  `thinking_delta` appends text, `signature_delta` appends the signature — and kept in block-index
  order, because Anthropic validates the sequence and not merely each block.
- `redacted_thinking` blocks are captured too. They carry an opaque `data` payload and no readable
  text, so replay is the only thing they are good for.
- On replay the blocks lead the assistant turn, ahead of `text` and `tool_use`.
- **A block with no signature is never sent as thinking.** Anthropic verifies the signature against
  the block and rejects an unsigned one, so a block whose `signature_delta` never arrived (an
  aborted stream) degrades to a plain text block instead. pi-mono carries the same note: "real
  Anthropic rejects empty thinking signatures".
- **Merging two assistant turns drops the incoming thinking.** Consecutive same-role messages are
  merged for the tool_result grouping, and appending a second signed sequence behind the first
  one's text gives `thinking, text, thinking, text` -- rejected, because a message's consecutive
  thinking blocks must be the ones it generated and must lead it. Claude Code merges the same way
  in `ensureToolResultPairing` and ships a documented 400 with it.
- It is **not** tied to `ANTHROPIC_HIDE_THINKING`. An earlier version gated it on summarized
  display, on the assumption that the signature covered the raw thinking rather than the summary.
  That was wrong: "The `signature` field is identical whether `display` is `"summarized"` or
  `"omitted"`." An omitted block round-trips exactly as well.

### OpenAI-compatible chat (`provider.ts`) — on by default, per model

DeepSeek, GLM, Kimi and Qwen all expose reasoning on the OpenAI chat-completions shape, and three
of the four document replay as required once `tools` are present:

| provider | field | with tools | if omitted |
| --- | --- | --- | --- |
| DeepSeek | `reasoning_content` | required | **400** |
| GLM (Zhipu) | `reasoning_content` | required | degrades, cache misses |
| Kimi K3 / K2.7-code | `reasoning_content` | required | degrades |
| Kimi K2.6 | `reasoning_content` | opt-in (`thinking.keep`) | ignored |
| Qwen | `reasoning_content` | not documented | not documented |
| OpenRouter | `reasoning_details` | recommended | not specified |

**Which field is not configured, it is looked up.** models.dev publishes `interleaved.field` on 881
models: 819 say `reasoning_content`, 14 say `reasoning_details`, and 48 carry a bare `true` that
names no field. It is per *model*, not per provider — OpenRouter alone publishes both. `pricing.ts`
already downloads that file, so the field rides in on the existing model row
(`LlmModelConfig.reasoningField`) and reaches the transport through `ResolvedLlmConfig`.

A bare `true` is discarded: it says the model interleaves without saying how to feed it, and
guessing a field name is how you send a body a strict endpoint rejects.

The two shapes are not interchangeable. `reasoning_content` takes the text; `reasoning_details`
takes the structured array verbatim, because that form exists precisely to carry encrypted and
summarized blocks that a string cannot represent. A model asking for `reasoning_details` on a turn
where only text was captured gets nothing rather than a downgrade.

One deliberate asymmetry: an **empty** captured `reasoning_content` is still sent. DeepSeek returns
an empty string on turns it did not think through, and that empty string still has to go back.

## Configuration

`llm.providers.<key>.reasoningReplay`, a tri-state boolean: absent means on.

```json
"llm": { "providers": { "deepseek": { "reasoningReplay": false } } }
```

It is hot-reloadable (`llm` is already a hot section) and editable from the app under
Providers → *provider* → settings. It replaces an earlier `ANTHROPIC_THINKING_REPLAY` env var,
which needed a restart and was invisible to `/config`.

**Default on, and safe to be.** The replay is self-gating: nothing is captured for a provider that
returns no reasoning, or for a model that publishes no field, so the switch is a no-op on every
endpoint that does not participate. The only failure mode it guards against is an endpoint that
*emits* reasoning and *rejects* it on input — none is documented, but the escape hatch costs one
toggle and no redeploy.

The switch covers all three transports, including the `include: ["reasoning.encrypted_content"]`
request field on Codex: turning it off takes the whole feature off the wire rather than leaving the
request field behind with nothing to serve.

## Weight

Replayed reasoning is prompt content the model is billed for, and `estimateMessagesTokens` counts
it: an encrypted reasoning item is a base64 blob that can run to kilobytes, and a long tool loop
replays one per assistant turn.

Leaving it uncounted would have been the 0.4.42 over-read inverted, and the inverted form is worse.
Over-reading fires a compaction that was not needed; under-reading walks into a hard context
rejection having trimmed nothing, because every reader of occupancy -- the compaction gate,
`trimToContextWindow`, `/status`, the app header -- believed the prompt was smaller than it was.

It is counted at the same chars-per-token as everything else. Dense base64 almost certainly
tokenizes worse than prose, so the figure is a floor rather than an estimate; inventing a multiplier
nobody measured would be the same mistake pointing the other way. Whether the replay should also be
*bounded* (OpenRouter exposes `reasoning.context: current_turn` for exactly this) is left open until
there is a measurement to bound it against.

## Known gaps

- **`allowEmptySignature`.** pi-mono carries a per-model flag for Anthropic-*compatible* endpoints
  that emit thinking blocks with empty signatures and expect them back; real Anthropic rejects
  those. `config.baseUrl` can point an `anthropic`-type provider at such an endpoint, so the case is
  reachable, but nothing here is configured that way. Until something is, the current behaviour is
  safe everywhere -- an unsigned block degrades to text, which never fails -- and the symptom on
  such a proxy would be visible reasoning that stops being replayed, not an error. Deliberately not
  configured rather than guessed at.
- **Surrogate sanitising.** pi-mono scrubs lone UTF-16 surrogates out of thinking text before
  sending it. Not reproduced here, and not observed.

## Containment

`ProviderMeta` is opaque, signed for one model, and often large. Three rules, each with a test in
`tests/llm/provider-meta-containment.test.ts`:

1. **It is never persisted.** `SessionMessage` has no field for it. The bridge attaches it to the
   in-memory `chatMessages` entry and *not* to `persistedAssistant`, a few lines below in the same
   block. Its whole value is spanning the tool iterations of the run in progress; across runs it
   would be a session file full of megabytes of base64, replayed months later at a model that
   never produced it.
2. **It never crosses protocols.** All three transports build their payload field by field —
   `toWireMessage` for chat completions, `buildInput` for Responses, `buildRequest` for Anthropic —
   so a field none of them names cannot leak into a protocol with no slot for it.
3. **It is tagged and checked, on all three transports.** Every blob carries the `backend` and
   `model` that produced it. A `rs_` item handed to another model is a 400, and Anthropic documents
   the same rule ("Thinking blocks are tied to the model that produced them... strip them when you
   switch"). On Anthropic the readable thinking survives a switch as plain text, because only the
   signature went stale; encrypted and redacted state has nothing to degrade to and is dropped.
4. **An incomplete turn contributes nothing.** A truncated response can carry a half-formed
   reasoning item, and handing that back is how a signed chain is refused for the rest of the run.
   The visible text is kept either way.

One regression worth recording: the chat-completions body was built from the raw `ChatMessage[]`
whenever prompt caching was off, so `providerMeta` was serialized straight onto the wire.
`toWireMessage` was the fence and that path walked around it. Both paths now go through it, and a
test asserts the two produce the same fields.

Because it never reaches the session store, it never crosses a compaction boundary and there is
nothing to invalidate at `promptBase`: the state simply does not outlive the run that made it.

## What the neighbours do

**Claude Code** replays thinking blocks with their signatures, and has a whole cluster of
open bugs from doing so. The mechanism, as one field report puts it:

> the server signs the block over its exact serialized bytes, so the client has to replay it
> verbatim. the moment a harness round-trips it through its own typed message model (parse to a
> struct, drop a null field, reorder keys on re-serialize) the bytes drift and the signature stops
> validating, even though the visible content is identical.

Its session transcripts store the thinking text emptied to `""` with the signature kept, its
message-repair pass reorders and merges blocks, and the resulting 400 has no in-session recovery --
the community fix is a tool that strips every thinking block from the transcript so the session can
resume. Both of the failure shapes above were found by reading those reports against our own code.

**pi-mono** (`badlogic/pi-mono`) is the most careful implementation of the three. Worth copying, and
copied: the unsigned-block degradation, and a per-model `allowEmptySignature` compat flag for
Anthropic-compatible providers that emit empty signatures and expect them back — real Anthropic does
not. It also converts thinking to plain text on a model switch rather than dropping it, which keeps
information we currently discard.

**opencode v2** replays unconditionally with no configuration, sends `reasoning_content` to every
OpenAI-compatible provider including the OpenRouter models that publish `reasoning_details`, never
sends the OpenAI Responses `include` on its v2 runner path (so that transport replays nothing at
all), and has no `redacted_thinking` handling anywhere.

## Rejected alternatives

- **`store: true`.** Lets OpenAI hold the state and costs one id per turn instead of a payload. It
  also means the conversation is retained server-side, which is the thing `store: false` is there
  to prevent.
- **Persisting the metadata with the session.** See containment (1). It converts a bounded in-run
  optimisation into an unbounded storage and invalidation problem.
- **A single global switch.** The requirement genuinely differs per provider and is not derivable
  from a model id, so one boolean would have been wrong in both directions.
- **Guessing the chat field from the model name.** `deepseek` in an id says nothing about which
  proxy is in front of it. models.dev publishes the answer; a substring match invents one.
- **Sending `reasoning_content` to every OpenAI-compatible endpoint** (what opencode v2 does). It
  reaches OpenRouter models that publish `reasoning_details`, where the string form cannot carry
  the encrypted block it is standing in for.

## Where

- `src/llm/provider.ts` — `ReasoningItem`, `ThinkingBlock`, `ProviderMeta`, the `ChatMessage` slot
- `src/llm/codex.ts` — `include`, capture at `output_item.done`, replay in `buildInput`
- `src/llm/anthropic.ts` — `THINKING_REPLAY`, capture in `processStream`, replay in `buildRequest`
- `src/llm/provider.ts` — `chatProviderMeta` capture, replay in `toWireMessage`
- `src/llm/pricing.ts` — `interleaved.field` ingestion (`reasoningFieldOf`), cache version 4
- `src/llm/catalog.ts`, `src/llm/resolver.ts` — model row -> resolved config
- `src/core/config.ts`, `src/core/config-edit.ts` — `reasoningReplay`, `ReasoningField`
- `src/agent/bridge.ts` — attaches the metadata to the in-memory turn only, and never on an
  incomplete turn
- `tests/llm/reasoning-replay-codex.test.ts`, `tests/llm/reasoning-replay-anthropic.test.ts`,
  `tests/llm/reasoning-replay-chat.test.ts`, `tests/llm/provider-meta-containment.test.ts`
