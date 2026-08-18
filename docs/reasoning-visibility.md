# Reasoning visibility

Show what the model thought, in the app, while it thinks — collapsed by default, expandable to
read, and still there when the conversation is reopened.

Scope: the `my-claw-app` channel only. Matrix and Telegram are unchanged; they get nothing new
because they never pass the sink (see "One sink, three engines").

## What each engine can actually give

Measured, not assumed. The capability differs per transport, and the design follows the weakest
one instead of pretending they are uniform.

| Engine | Transport | Reasoning text | Evidence |
| --- | --- | --- | --- |
| home loop, `type: "openai"` | Chat Completions | **full, streamed** | measured on `opencode_go`: `reasoning_content` deltas on `deepseek-v4-flash`, `deepseek-v4-pro`, `qwen3.7-plus`, `kimi-k3`; none at all on `minimax-m3` |
| home loop, `type: "codex"` | OpenAI Responses | **summary text**, already requested and thrown away | `codex.ts:289` sends `reasoning: { effort, summary: "auto" }`; the `switch` handles no `response.reasoning_*` event |
| `type: "claude-sdk"` | Claude Code bridge | **none — redacted** | `SDKThinkingTokensMessage` (`sdk.d.ts:4641`): the raw text never leaves the bridge, only a running `estimated_tokens` "for spinners/pills, not the authoritative billed output_tokens" |

The redaction is a property of the **subscription bridge**, not of Anthropic: the Messages API
streams real `thinking_delta` blocks. my-claw has no `anthropic-messages` transport today, so the
question is moot; if one is ever added it lands in the "full text" row, and this spec's data model
already carries it.

`minimax-m3` proves the feature must degrade to nothing gracefully: a model that reasons silently
is normal, not an error.

### Field names, in order

An OpenAI-compatible endpoint may use any of three names, and some send two of them with identical
content. Take the **first non-empty** and ignore the rest:

```
reasoning_content   >   reasoning   >   reasoning_text
```

Order and dedupe rationale are pi's, whose parser carries the same fallback and notes
`chutes.ai` duplicating two fields (`packages/ai/src/api/openai-completions.ts:493`). pi also
special-cases `provider === "opencode-go"` returning `reasoning` rather than `reasoning_content`,
so the fallback is load-bearing on this very gateway even though today's probe saw only
`reasoning_content`. OpenRouter (a configured provider here) uses `reasoning`.

`reasoning_details` (OpenRouter's encrypted, replay-oriented form) is **out of scope**: it is a
protocol artifact for continuing a reasoning chain, not something a human reads.

Responses API event names, from the same source
(`packages/ai/src/api/openai-responses-shared.ts:602,612,622`):

- `response.reasoning_summary_text.delta` — the summary `summary: "auto"` already asks for
- `response.reasoning_text.delta` — raw reasoning, when a model exposes it

## The protocol constraint, and why we still do not replay

DeepSeek documents that with `tools` in the request, `reasoning_content` **must** be echoed back on
assistant messages in every subsequent request of the same chain, or the API answers **400**
(Thinking Mode guide, "Tool Calls"). my-claw captures none of it and replays none of it.

Measured against the gateway actually in use: a tool round-trip **without** `reasoning_content`
returns **200**, and **with** it returns **200**. `opencode.ai/zen/go` is lenient.

Therefore: **store the reasoning, never replay it.** Rationale, in order of weight:

1. Replaying it would change what the model sees, which is a behaviour change smuggled into a
   display feature. Not acceptable in the same step.
2. Today's provider does not need it. A direct `api.deepseek.com` provider would; that is a
   separate, provider-scoped compat flag when someone adds one (pi's name for it:
   `requiresReasoningContentOnAssistantMessages`).
3. The reasoning is stored as a display-only field, so the flag has its data ready the day it is
   needed.

This is recorded here so the next person does not read "we store reasoning" and conclude the
DeepSeek tool-chain contract is satisfied. It is not.

## Data model

`SessionMessage`'s assistant variant gains one optional, display-only field:

```ts
| { role: "assistant"; content: string; timestamp: string;
    toolCalls?: [...]; reasoning?: string; reasoningTokens?: number }
```

`reasoningTokens` is the redacted engine's half of the same field. The Claude bridge gives a
running `estimated_tokens` and no text at all, so the live counter was the whole trace of a turn's
thinking, and it died with the stream: a reopened thread showed a bubble that had apparently
thought nothing. The backend keeps the last estimate seen before the turn it mirrors, one integer
per turn, and the app replays it as `Thought . 12.3k tokens` in the same muted line. A turn that
thought nothing stores nothing.

It must never reach a model. Two paths replay the mirror, and both build explicit objects field by
field, so an added field cannot leak by accident:

- `AgentBridge.toChatMessages` (`bridge.ts:369`) — the home loop's prompt
- `renderPriorConversation` (`claude-sdk/history.ts`) — the engine-switch transcript

"Cannot leak by accident" is not the same as "is tested not to leak": one test per path asserts a
stored `reasoning` is absent from the built prompt. That test is the whole guarantee.

Compaction summarises messages and drops the field with them — correct, a summary of a reply has no
reasoning of its own. `trimSessionMessages` and `sealDanglingToolCalls` are untouched.

**Cap:** `REASONING_LIMIT = 8000` characters per assistant turn, truncated with a marker. Same
reasoning as `TOOL_OUTPUT_LIMIT`: sessions are single JSON files rewritten in full on every turn,
and an unbounded chain-of-thought would rewrite megabytes per message and push them through the
socket. A capped tail is a reading aid; the full text was never a durable artifact.

## One sink, three engines

`handleMessageStreaming` already takes seven positional parameters. Rather than grow that list per
signal, one trailing optional parameter carries both shapes:

```ts
export interface ReasoningSink {
  /** Reasoning text, incremental. Absent engine-side means the transport has none. */
  onText?: (delta: string) => Promise<void>;
  /** Running estimate while a redacted engine thinks. Claude bridge only. */
  onTokens?: (estimated: number) => Promise<void>;
}
```

Appended last, deliberately: this codebase has already been bitten by inserting a parameter ahead
of a test seam (`ClaudeSdkBackend`'s `queryFn`). Appending cannot shift an existing argument.

Threading, per file:

1. `llm/provider.ts` — `chatCompletionStream(..., sink?)`. Apply the field fallback per chunk; call
   `sink.onText`. `chatCompletion` (non-stream) reads `message.reasoning_content` into
   `LlmResponse.reasoning` so a non-streaming run still persists it.
2. `llm/codex.ts` — `codexResponseStream(..., sink?)`. Add the two `response.reasoning_*` cases.
   The request already asks for summaries; this only stops discarding the answer.
3. `agent/bridge.ts` — pass the sink through to whichever transport it selected (`bridge.ts:62`
   already branches codex vs chat completions), and write the accumulated text onto the assistant
   mirror message it pushes.
4. `agent/claude-sdk/backend.ts` — handle `{ type: "system", subtype: "thinking_tokens" }` and call
   `sink.onTokens`. The `SdkStreamMessage` read-view grows two fields. No text path exists.
5. `agent/backend.ts` — the interface. `core/router.ts` — `RouteOptions.reasoning?`, forwarded at
   `router.ts:196`.
6. `index.ts` — only the app branch (`index.ts:1969`) builds a sink; the Telegram and Matrix
   branches pass none, which is how those channels stay untouched.

A sub-agent's reasoning is not forwarded: sub-agent traffic already does not stream into the
parent's bubbles, and the same rule applies here.

## Wire protocol

Two additive server frames, and one additive history field.

```ts
/** Incremental reasoning for the bubble `id`. Text engines only. */
{ type: "chat.reasoning.delta"; id: string; threadId: string; text: string }

/** Running estimate while a redacted engine thinks. No text will follow. */
{ type: "chat.reasoning.tokens"; id: string; threadId: string; tokens: number }
```

`MyClawAppHistoryEntry`'s assistant entry gains `reasoning?: string`, filled by
`sessions.ts:211` from the mirror field.

No lockstep release. The app validates incoming frames against a `Set` (`protocol.ts:872`), so an
older app drops both frames and renders exactly what it renders today; a newer app on an older
server simply never receives them.

## Streamer semantics

`MyClawAppStreamer` (`channels/my-claw-app/stream.ts`) gains `pushReasoning(delta)` and
`pushReasoningTokens(n)`, both going through the existing `enqueue` queue so reasoning, text, tool
cards and `done` cannot interleave out of order.

Rules:

- **Reasoning opens the bubble.** If no segment has started, `pushReasoning` calls `startSegment()`
  itself. This is the point of the feature: the thinking phase is exactly the long silence the
  owner currently stares at, so the bubble must exist before the first word of the answer.
- `minCharsBeforeDelta` never withholds reasoning. Holding the thinking back to reach a character
  threshold would defeat the purpose.
- **The threshold gates the opening, not the throughput.** It is documented as "the full text
  length at which the first delta is pushed" and has only ever been checked while no segment had
  started. So once reasoning has opened the bubble, short text is no longer withheld: the bubble is
  already on screen, and there is nothing left for the threshold to protect. Measured and locked by
  a test, because reading the knob as a throttle is the natural mistake here.
- **Reasoning belongs to its segment.** `toolInternal` seals the bubble and resets the reasoning
  accumulator, so a model that thinks again after a tool fills the *next* bubble's reasoning
  instead of appending to a sealed one.
- **An answer seals the bubble for the next thought too.** A tool call is not the only thing that
  ends a segment: reasoning that arrives once visible text has been sent seals the bubble and opens
  the next one (`sealBeforeReasoning`). Without it the thinking was patched onto the bubble the
  reader was already reading, where it renders *above* that text, and the words that followed
  continued the same bubble: two answers glued together under the header of the second one.
  Reported from the app, and it is the shape the mirror already has, since
  `mirrorAssistantMessage` stores one assistant message per model turn and attaches the estimate of
  the thinking that *preceded* it. Live stream and replayed history now agree.
  A thinking phase that has not answered yet is never split: the condition is visible text
  (`emittedText`), so a running token estimate keeps landing on the bubble it opened.
- **A reasoning-only bubble survives `finish`.** Today an empty-text bubble is removed
  (`chat.ts:224`). A bubble that carries reasoning but no text is not empty: it explains a tool
  call that produced no prose. Keep it.
- Deltas are diffs of the accumulated text, mirroring `emitDelta`, because the device accumulates
  what it receives.
- Truncation at `REASONING_LIMIT` happens once, server-side, and stops further deltas for that
  segment.

## App

`core/protocol.ts` — the two frame types plus their entries in `FRAME_TYPES`.

`core/chat.ts` — `TextItem` gains:

```ts
reasoning?: string;
/** Redacted engines: a count with no text to show. */
reasoningTokens?: number;
```

plus `appendReasoning(threadId, id, delta)` and `setReasoningTokens(...)`, accumulating through the
same `streams`-style map so a late frame for a closed bubble is ignored rather than resurrecting it.
`endStream` keeps an item when `reasoning` or `reasoningTokens` is present. `seedHistory` reads the
new history field.

## UI/UX

One line, at the top of the agent's own bubble. Not a separate bubble: the reasoning belongs to the
answer it produced, and a second bubble would double the vertical rhythm and orphan itself whenever
the answer is one sentence. During the thinking phase the bubble holds only this line, which is
precisely the "it is working" affordance; it then grows into the answer without anything jumping.

**Collapsed — the default, always.**

```
▸ Thinking…                      (while reasoning streams, no text yet)
▸ Reasoning                      (text arrived, or the run ended)
▸ Thought · 1.2k tokens          (Claude: a count, because there is nothing to open)
```

Muted, small, no border, no background — it must lose every contest with the answer. Expansion is
per-bubble, local, and never persisted: reopening a conversation shows it collapsed again, which is
what "collapsed by default" has to mean to be worth anything.

**Expanded.** The text in the same muted tone, behind a left rule to mark it as an aside, and
selectable. A truncated body says so on its last line.

**Interaction.** The whole row is the tap target, reusing `ToolCard`'s idiom verbatim for
consistency and accessibility: `Pressable`, `accessibilityRole="button"`,
`accessibilityState={{ expanded }}`, `accessibilityHint` of "Show the model's reasoning" /
"Hide the model's reasoning".

**The redacted case is not a button.** With Claude there is no body to reveal, so the row renders
as static muted text. A control that opens nothing is worse than no control.

No setting in v1. A collapsed line is unobtrusive enough that a preference would be
configuration for its own sake; if it ever proves noisy, the natural home is the app's existing
verbose switch, which already governs tool cards.

## Tests

Server, each one failing before the change:

- `provider.ts`: each of the three field names drives the sink; two fields with identical content
  emit once; an absent sink is a no-op; a chunk with neither field changes nothing.
- `codex.ts`: `response.reasoning_summary_text.delta` and `response.reasoning_text.delta` reach the
  sink; unknown `response.reasoning_*` events are ignored rather than throwing.
- `claude-sdk/backend.ts`: `thinking_tokens` reaches `onTokens`; `text_delta` still reaches
  `onToken` and never `onText`.
- `stream.ts`: reasoning before any text opens the bubble; a tool seals and resets the accumulator;
  a reasoning-only bubble survives `finish`; `minCharsBeforeDelta` does not delay reasoning; order
  under concurrent pushes.
- **The leak tests**: an assistant mirror message carrying `reasoning` produces a prompt without it,
  through `toChatMessages` and through `renderPriorConversation`.
- `sessions.ts`: history replay carries `reasoning` and `reasoningTokens`, and a turn without
  either replays without the field; the cap truncates and marks.
- `claude-sdk/backend.ts`: the estimate seen before a turn is stored on that turn, the turn after
  it is not credited with the same count, and a turn that never thought carries no field.
- **Matrix and Telegram**: guaranteed structurally rather than by a channel test — those branches
  build no sink, and every engine is tested to run unchanged when the sink is absent. There is no
  reasoning frame in their protocols to assert on.

App:

- store: deltas accumulate; a delta for an unknown or closed bubble is dropped; a reasoning-only
  bubble is not removed on `endStream`; history seeds the field.
- `Bubble`: collapsed by default — the body is *not* in the tree; pressing reveals it; the redacted
  variant renders a count and exposes no button. The collapsed-by-default assertions were confirmed
  to fail when the line is opened by default, so they are not vacuous.

## Non-goals

- Reasoning in Matrix and Telegram.
- Replaying reasoning to any model (see the constraint section).
- `reasoning_details` / encrypted reasoning continuation.
- Reasoning for sub-agent runs.
- Search or export of reasoning text.
