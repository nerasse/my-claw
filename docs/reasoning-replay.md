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
- `buildInput` emits `{ type: "reasoning", id, summary: [], encrypted_content }` **ahead of** the
  `function_call` items of the same assistant turn. The order is load-bearing — the API rejects a
  reasoning item that does not precede the call it produced.

### Anthropic (`anthropic.ts`) — opt-in, off by default

- `ANTHROPIC_THINKING_REPLAY=1` turns it on. It additionally requires `display: "summarized"`, so
  it is inert under `ANTHROPIC_HIDE_THINKING=1`: an omitted thinking block has no text to replay.
- Thinking blocks are stitched from three events — `content_block_start` opens the block,
  `thinking_delta` appends text, `signature_delta` appends the signature — and kept in block-index
  order, because Anthropic validates the sequence and not merely each block.
- `redacted_thinking` blocks are captured too. They carry an opaque `data` payload and no readable
  text, so replay is the only thing they are good for.
- On replay the blocks lead the assistant turn, ahead of `text` and `tool_use`.

**Why this one is opt-in.** The signature covers the model's original thinking, and Anthropic
answers 400 to a sequence it considers modified, reordered or partially filtered. This is also the
transport where pruning is deliberately skipped and where a compaction boundary can cut a signed
chain in half. The upside is real; the failure mode is a hard 400 on a live run. It stays behind a
flag until it has been exercised against the real endpoint.

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
3. **It is tagged and checked.** Every blob carries the `backend` and `model` that produced it, and
   is dropped rather than replayed on a mismatch. A `rs_` item handed to another model is a 400.

Because it never reaches the session store, it never crosses a compaction boundary and there is
nothing to invalidate at `promptBase`: the state simply does not outlive the run that made it.

## Rejected alternatives

- **`store: true`.** Lets OpenAI hold the state and costs one id per turn instead of a payload. It
  also means the conversation is retained server-side, which is the thing `store: false` is there
  to prevent.
- **Persisting the metadata with the session.** See containment (1). It converts a bounded in-run
  optimisation into an unbounded storage and invalidation problem.
- **Replaying Anthropic thinking by default.** See above. The measured downside is a 400 that kills
  a live run, and the flag costs one env var.

## Where

- `src/llm/provider.ts` — `ReasoningItem`, `ThinkingBlock`, `ProviderMeta`, the `ChatMessage` slot
- `src/llm/codex.ts` — `include`, capture at `output_item.done`, replay in `buildInput`
- `src/llm/anthropic.ts` — `THINKING_REPLAY`, capture in `processStream`, replay in `buildRequest`
- `src/agent/bridge.ts` — attaches the metadata to the in-memory turn only
- `tests/llm/reasoning-replay-codex.test.ts`, `tests/llm/reasoning-replay-anthropic.test.ts`,
  `tests/llm/provider-meta-containment.test.ts`
