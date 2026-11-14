# Reasoning visibility

> **Note historique** : ce document a été écrit quand my-claw servait aussi Telegram et Matrix.
> Ces deux canaux ont été supprimés (seul `my-claw-app` subsiste). Les mentions et chemins de
> fichiers `channels/telegram/*` et `channels/matrix/*` ci-dessous sont conservés pour la trace
> de la décision : ils ne décrivent plus le code.

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
| home loop, `type: "codex"` | OpenAI Responses | **summary text, for part of the thoughts**; a count for every call | `reasoning: { effort, summary: "auto" }`; see "A thought with no words" |
| `type: "claude-sdk"` (removed) | Claude Code bridge | **none — redacted** | `SDKThinkingTokensMessage` (`sdk.d.ts:4641`): the raw text never left the bridge, only a running `estimated_tokens` |

| `type: "anthropic"` | Messages API | **full, streamed** | `thinking_delta` blocks, asked for with `thinking.display: "summarized"` -- docs/anthropic-backend.md |

The redaction is a property of the **subscription bridge**, not of Anthropic: the Messages API
streams real `thinking_delta` blocks, which is what the native transport added when it landed.

Every transport also reports **what the call spent thinking**, read off its usage:
`completion_tokens_details.reasoning_tokens` (Chat Completions), `output_tokens_details.reasoning_tokens`
(Responses), `output_tokens_details.thinking_tokens` (Messages). It is a subset of the output count,
never added to it, and it only exists once the call has answered -- see "A thought with no words"
for how it reaches the bubble without opening a second one.

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
- `response.reasoning_summary_part.added` — a **new part** of that summary begins

### A thought with no words

Measured on `gpt-6.1-sol` (2026-10-26), through the backend directly: with `summary: "auto"` the
Responses API writes a summary for only part of its thoughts. The rest come back as a reasoning
item with `summary: []` and no delta at all, while `reasoning_tokens` says 500 to 1 000 tokens were
spent. Same request, run again: sometimes 2 000 characters of summary, sometimes none. It falls with
the effort (`low` and `medium` were mostly silent, `xhigh` two times out of three) and with the
shape of the step: a call that reads a file and goes to the next tool thinks little and is rarely
summarised. On the owner's sessions that day, 82 % of the phases had neither words nor anything
else to show, and a run chaining tools looked like it did not think at all. Neither `detailed` nor
dropping `include: ["reasoning.encrypted_content"]` changes it; `concise` summarised every call of a
small sample, in one heading of 25 to 45 characters, and is left untried here.

So the count is shown for every call, beside the words when there are some and alone when there are
none: `Reasoning · 516 tokens · 4.2 s`.

- **One count per call, reported once.** The bridge reads `usage.reasoningTokens` once the call has
  answered, before the turn is recorded and before its tools open their cards, and hands it to the
  run's sink (`ReasoningSink.onCount`). Before the recorder, because the recorder claims the ids of
  the bubbles the call wrote into; before the cards, so the count reads above the tool it led to.
- **It lands on the bubble its call wrote into, and never seals it.** The count arrives after the
  answer, and a thought sealing an answer is the rule for *words*: applied to a count, it gave the
  count a bubble of its own under the reply. A call that wrote nothing still has its bubble, opened
  by `beginWait` when the call started, so the count fills it and the bubble survives the end of
  the stream.
- **It opens no span and closes none.** The words are timed where they stream (`since`, below); a
  count is a figure about a thought that is over.
- **A span always travels with it, and the server's figure wins.** `ms` used to be sent only for a
  call that streamed no words, on the argument that the client had timed the ones it streamed. That
  argument is the defect: the app measures a wall clock across a socket, from the frame that opens
  the phase to the first prose delta, while the server measures the same span where the deltas
  arrive -- and its figure is the one the log stores and the one a reload shows. A phase read
  `12 s` live and `4 s` after a refresh (owner, 2026-11-14: "le ms serveur c'est lui l'important").
  The app adopts `ms` and drops its own measurement for that bubble, so the seal at the first delta
  cannot overwrite the answer a moment later.
- **The span is the last phase's own, not the turn's total.** A count is one number for the whole
  call and it lands on the last phase (`run-recorder.ts` puts `reasoningTokens` there). `reasoningMs`
  on a multi-phase response is the sum of every phase, so the bridge reads the last segment's own
  duration -- handing the sum to one bubble made it read the whole turn's thinking.
- **A silent thought is timed by its reasoning item.** No delta, so the segmenter never sees it: the
  Responses transport measures each reasoning item from `output_item.added` to `output_item.done`
  and returns that as `reasoningMs`. A span of zero is not a span and does not travel.
- **On Codex, the item's lifetime is the span, words or none.** That backend does not stream a
  thought, it reports one: a thought kept to itself (`encrypted_content`) sends no delta, and a
  thought it summarises sends its summary parts **when the item closes**. A span measured from the
  first delta to the first word of the answer therefore measures the burst of the summary, not the
  wait the reader sat through -- 25 ms reported for 325 ms of thinking, measured 2026-11-14. Each
  phase takes its own item's lifetime, paired from the end like the bubbles are, and the last item
  is what the count rides on. OpenAI-compatible providers and Anthropic do stream their reasoning
  as it happens, so their segmenter span is the right one and stays.
- **The log keeps it** on the last phase of the call (`reasoningTokens`, beside `reasoningMs`), so a
  reopened thread shows the same line the live one did.

### A summary comes in parts, and the parts need a separator

The summary is not one string. GPT sends it as parts, each a `**Heading**` run of its own, and the
API puts nothing between them. Appended raw they weld at the seam:

```
**Locating user workspace directory****Inspecting git status and recent changes**
```

Those four asterisks are a closing `**` meeting an opening `**`. Marked resolves it by matching the
outermost pair and leaving the rest as literal text, so it renders as one bold run with `****`
printed in the middle of it. Forty of those accumulated on this install before anyone traced the
cause to the transport, and it was mistaken for a Markdown-rendering bug: `****` alone on a line
*is* an `hr` in Marked, which sends the investigation to the renderer instead of here.

A part boundary is therefore a paragraph break, taken from `summary_index` on the delta and from
`part.added`, whichever the stream provides. The break is written to the stored reasoning, to the
segment cuts and to the live sink alike, or a replayed turn would read differently from the one the
owner watched. It is held until the new part actually produces text, so a boundary announced at the
end of a response leaves no trailing blank line.

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
    toolCalls?: [...]; reasoning?: string; reasoningTokens?: number; reasoningMs?: number;
    segments?: Array<{ reasoning?: string; reasoningMs?: number; content: string }> }
```

`reasoningTokens` is what the call spent thinking, as the endpoint counted it, one integer per call
on its last phase. It was first the redacted engine's half of the field (the Claude bridge, since
removed); it is now written for every transport that reports a count, words or none -- "A thought
with no words". A call that thought nothing stores nothing.

It must never reach a model. Two paths replay the mirror, and both build explicit objects field by
field, so an added field cannot leak by accident:

- `AgentBridge.toChatMessages` (`bridge.ts:369`) — the home loop's prompt
- `renderPriorConversation` (`claude-sdk/history.ts`) — the engine-switch transcript

"Cannot leak by accident" is not the same as "is tested not to leak": one test per path asserts a
stored `reasoning` is absent from the built prompt. That test is the whole guarantee.

### `segments`: where the turn was cut on screen

One API call can think, answer, think again and keep writing. The live stream closes its bubble at
the second thought (see "An answer seals the bubble for the next thought too"), the mirror stores
one assistant message per call, and those two shapes disagree: replayed, the phases came back glued
into one bubble with every thought stacked above text they were not about. The app refetches the
open conversation on every reconnect, so the merged version overwrote the split one the reader had
watched being written.

`segments` records the cuts, and only when there is more than one phase: a single-phase turn says
exactly what `content` and `reasoning` already say, and storing it would double every turn on disk.
`content` remains the whole turn, so nothing about the prompt or the compaction changes.

The cut rule lives once, in `llm/reasoning-segments.ts` (`ReasoningSegmenter`), fed by
`chatCompletionStream` and `codexResponseStream` as the deltas arrive. It is the streamer's own
rule, reasoning after visible text opens the next phase, and
`tests/channels/reasoning-segments.test.ts` runs one event order through both and asserts they
produce the same phases: two implementations of one rule drift, so the drift is what the test
watches.

### `reasoningMs`: how long the thinking lasted

`segments` carries a duration per phase, and the single-phase turn carries one on `reasoning`
itself. Both are measured by the same `ReasoningSegmenter`, at the only place that sees both ends
of a span: the first reasoning delta opens it, the first text delta after it closes it, and a
turn that ends on a thought is closed when the response is read out.

Until 2026-09-11 that span lived only in the app's memory. The live counter was real, and the
moment the thread was reopened every thought came back as an untimed aside — the reader had
watched a phase take forty seconds and the reload said nothing about it. The duration is now
written on the phase and travels with it, which is what the owner asked for: always visible, on a
reload, mid-run, and mid-reload.

The span is measured where the deltas arrive, not guessed from neighbouring timestamps: a turn
that goes straight to a tool call after thinking closes its span when the segmenter is read, and a
span of zero is not written at all rather than stored as `0`.

The app draws it with the span format every counter in the thread shares (`formatSpan`,
2026-09-22): milliseconds under a second, one decimal from one to ten seconds (`2.3 s`), whole
seconds, then `2 min 33 s`, then `2 h 33 min`. This line used to keep two decimals forever while
three other formatters said the same span differently, and a long phase read `1m 33.00s` -- "des
chiffres après la virgule alors que le truc a duré 30 minutes". The sub-second rung keeps the
thing the decimals were first bought for: a 4 ms phase reads `4 ms`, never `0s` (a phase that
never happened) and never `0.1 s` (twentyfold the truth). `tests/channels/reasoning-segments.test.ts`
pins the measurement, `display.test.ts` the frame that carries it, and the app's
`reasoningLine.test.tsx` the rendering.

A hook that rewrites the answer (`transform:agent:response`) drops the cuts: they are positions in
text that no longer exists, and a cut in the wrong place is worse than no cut.

The non-streaming path reports none. It sees a finished message, not the order the pieces arrived
in, so it cannot know where the thinking restarted. The claude-sdk path reports none either: its
thinking is redacted, so there is nothing to cut on.

Compaction summarises messages and drops the field with them — correct, a summary of a reply has no
reasoning of its own. `trimSessionMessages` and `sealDanglingToolCalls` are untouched.

**No cap.** There was one, 8 000 characters per turn, on the argument that sessions are single JSON
files rewritten in full and an unbounded chain of thought would rewrite megabytes per message. The
argument holds for the bytes and fails for the reader: a thought that stops mid-sentence is worth
less than no thought at all, and the marker admitting it was the most visible thing in the bubble.
The text never returns to the model, so the only thing the ceiling ever bought was disk. Tool output
keeps its own limit, which is a different trade: that one *is* replayed into the prompt.

## One sink, three engines

`handleMessageStreaming` already takes seven positional parameters. Rather than grow that list per
signal, one trailing optional parameter carries both shapes:

```ts
export interface ReasoningSink {
  /** Reasoning text, incremental. Absent engine-side means the transport has none. */
  onText?: (delta: string) => Promise<void>;
  /** What the call that just answered spent thinking, once. `ms` only when it streamed no words. */
  onCount?: (count: { tokens: number; ms?: number }) => Promise<void>;
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

A sub-agent's reasoning is not forwarded **to its parent**: sub-agent traffic does not stream into
the parent's bubbles, and the same rule applies here. It goes to the sub-agent's own thread, which
is a conversation the app can open (`docs/subagent-navigation.md`) -- its prose has streamed there
since the app first drove a sub-agent, and the thinking joined it on 2026-09-30. The field sat on
`SubAgentStream` unfilled until then: a window watching a child saw its cards and never a word of
what it thought, while the child's log held every summary. `channels/my-claw-app/subagent-stream.ts`
is the one door that builds it, read from the streamer map on every call so a steered child paints
into the bubble it holds now.

## Wire protocol

Three additive server frames, and one additive history field.

```ts
/** Incremental reasoning for the bubble `id`. Text engines only. */
{ type: "chat.reasoning.delta"; id: string; threadId: string; text: string; since?: string }

/** What the call that wrote into bubble `id` spent thinking, once it has answered. */
{ type: "chat.reasoning.tokens"; id: string; threadId: string; tokens: number; ms?: number }

/** A call began and has produced nothing yet -- `since`; or has just produced its first thing and
 *  this is what the wait cost -- `ms`. See "While nothing has come out of it". */
{ type: "chat.turn.wait"; id: string; threadId: string; since?: string; ms?: number }
```

`MyClawAppHistoryEntry`'s assistant entry gains `reasoning?: string`, filled by
`sessions.ts:211` from the mirror field, plus `waitMs?: number` from the phase, so a thread reopened
an hour later shows the same wait the live one did.

A replayed turn is walked phase by phase (`HistoryPhase`), so a turn with `segments` becomes one
entry per phase and a turn without them stays one entry. A phase that thought and then called a
tool has no prose, and it is still an entry: the bubble the reader saw *was* that thought, and
dropping it made a reopened thread jump from the question straight to a tool card.

No lockstep release. The app validates incoming frames against a `Set` (`protocol.ts:872`), so an
older app drops both frames and renders exactly what it renders today; a newer app on an older
server simply never receives them.

### `since`: the span survives the window that was watching it

A turn that settles carries its duration (`reasoningMs`, below). The turn **in flight** did not: the
frames carried no instant, so the client dated the span from the moment the first one reached it,
and a window reloading mid-thought started a new counter from zero on a thought that had been
running for forty seconds. The stored duration then contradicted what the reader had just watched.

`since` is the ISO instant the phase opened, server side, put on the frame that opens the phase --
the first delta. A count carries none: it opens no span.
An instant and not an elapsed time, for the reason `chat.compacting.since` carries one: a state
replayed to a window that arrives late cannot be a number that was true when it was computed.

Only the opening frame carries it, and that is what makes the replay work rather than something it
has to work around. `LiveTurnJournal` merges every delta of one subject onto the first one, so the
single frame a reloading window is served is the one holding the instant. The frames that follow
carry nothing on purpose: a second instant would move the start of a span still running.

The phase ends where the segmenter ends it. The streamer clears the span when it seals a bubble
(`sealSegment`), so thinking that follows an answer is timed from itself -- the same cut
`sealBeforeReasoning` already makes for the bubbles, applied to their clocks.

Both fields are optional and additive. An older app ignores them (`parseServerFrame` validates the
frame `type` and nothing else), and against an older server the app keeps dating the span from its
own `Date.now()`, which is what it did before.

## Streamer semantics

`MyClawAppStreamer` (`channels/my-claw-app/stream.ts`) gains `pushReasoning(delta)` and
`pushReasoningCount(count)`, both going through the existing `enqueue` queue so reasoning, text, tool
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
  Reported from the app. The mirror does not have that shape by itself, since it stores one message
  per API call: `segments` is what carries the cuts to the replay, so the live stream and a reopened
  conversation agree.
  A thinking phase that has not answered yet is never split: the condition is visible text
  (`emittedText`). A count never seals at all: it belongs to the answer it follows.
- **A reasoning-only bubble survives `finish`.** Today an empty-text bubble is removed
  (`chat.ts:224`). A bubble that carries reasoning but no text is not empty: it explains a tool
  call that produced no prose. Keep it.
- Deltas are diffs of the accumulated text, mirroring `emitDelta`, because the device accumulates
  what it receives.
- Truncation at `REASONING_LIMIT` happens once, server-side, and stops further deltas for that
  segment.

## While nothing has come out of it

Reasoning is not the only silence, and on Codex it is not even the common one: a call that goes
straight to a tool sends **no summary at all** (measured: three live calls with tools, zero
reasoning characters, four seconds each), and the first token of a turn that does summarise arrives
13 to 20 seconds in at effort `max`. A provider being retried is minutes of it. The app drew
nothing through all of that -- the thread looked dead, the Stop button its only sign a run was on
(owner, 2026-09-30).

So the run announces the call: `MyClawAppStreamer.beginWait()`, through the reasoning sink it
already hands the bridge (`ReasoningSink.onCallStart`). It opens the bubble the turn will write
into and sends `chat.turn.wait` with the instant the call began.

- **On the sink, never a global hook.** It went through `hooks.on("llm:call:start")` first, and a
  hook is heard by every listener on the session -- a message folded into a run in flight has one
  too, so both announced the run's calls in their own bubble: every turn after the steering message
  opened two, one of them never filled (owner, 2026-10-01). One door per run, read through the
  streamer that is open now: `run-sink.ts` for a run, `subagent-stream.ts` for a child.
- **The app takes it down, on the first thing the turn produces**: a token, a reasoning delta, a
  token count, a tool card, an abort, the run's end. The server does not track what is on screen;
  the client is the one that knows.
- **The app decides when it is worth drawing**: the line waits three seconds of silence before it
  appears, because the engines that stream their reasoning answer in one to two seconds and the line
  was a flicker there (measured: deepseek-v4.1-flash, 1658 ms). What it is for is the silence.
- **It carries the bubble's id**, so the live journal drops it with that bubble when it settles: a
  window that syncs mid-call is replayed the line, a window that syncs after the answer is not
  (`docs/live-turn-replay.md`).
- **One line with a counter**, drawn in the bubble in place of its caret, and deliberately the
  quietest thing on the screen. It sat at the foot of the thread at first, beside the empty bubble
  it had opened: a bare caret per turn, and a line that belonged to no bubble (owner, 2026-09-30).

## App

`core/protocol.ts` — the three frame types plus their entries in `FRAME_TYPES`.

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

Both take the frame's `since`. It **replaces** the local start when it is there, and the store falls
back to its own `Date.now()` when it is not (an older server, or a frame inside an open phase). An
unparseable value is treated as absent: the fallback is the local clock, never a `NaN` written onto
the item.

The span is sealed into `reasoningMs` by the first word of the answer, and a span that does not
measure as positive is not written at all -- the same rule `ReasoningSegmenter` applies to the
stored phase. Zero is what a phase that never happened looks like, and with the two ends of the
span now read from two clocks it is also what a device running ahead of the server would produce.

## UI/UX

One line, at the top of the agent's own bubble. Not a separate bubble: the reasoning belongs to the
answer it produced, and a second bubble would double the vertical rhythm and orphan itself whenever
the answer is one sentence. During the reasoning phase the bubble holds only this line, which is
precisely the "it is working" affordance; it then grows into the answer without anything jumping.

**Collapsed — the default, always.**

```
▸ Reasoning · 4 s                (while reasoning streams, no text yet)
▸ Reasoning                      (text arrived, or the run ended)
▸ Reasoning · 1.2k tokens 12 s   (words, and what the call spent on them)
  Reasoning · 516 tokens 4.2 s   (no words: a count, because there is nothing to open)
```

Muted, small, no border, no background — it must lose every contest with the answer. Expansion is
per-bubble, local, and never persisted: reopening a conversation shows it collapsed again, which is
what "collapsed by default" has to mean to be worth anything.

**Expanded.** The text in the same muted tone, behind a left rule to mark it as an aside, and
selectable. Whole, however long it ran.

**Two phases are two blocks.** The app groups consecutive bubbles of one author into a single
visual block (4px instead of 10px, timestamp on the last one only). A bubble that opens on a
reasoning phase leaves that block (`core/grouping.ts`), because grouping it put back exactly what
the seal had separated: the thought read as a note stuck under the answer already on screen, and
the words after it as that same message continuing. This is the same bug as the merged replay,
seen one layer higher.

**Interaction.** The whole row is the tap target, reusing `ToolCard`'s idiom verbatim for
consistency and accessibility: `Pressable`, `accessibilityRole="button"`,
`accessibilityState={{ expanded }}`, `accessibilityHint` of "Show the model's reasoning" /
"Hide the model's reasoning".

**The silent case is not a button.** A thought the endpoint kept to itself has no body to reveal,
so the row renders as static muted text: the count and the span. A control that opens nothing is
worse than no control.

No setting in v1. A collapsed line is unobtrusive enough that a preference would be
configuration for its own sake; if it ever proves noisy, the natural home is the app's existing
verbose switch, which already governs tool cards.

## Tests

Server, each one failing before the change:

- `provider.ts`: each of the three field names drives the sink; two fields with identical content
  emit once; an absent sink is a no-op; a chunk with neither field changes nothing.
- `codex.ts`: `response.reasoning_summary_text.delta` and `response.reasoning_text.delta` reach the
  sink; unknown `response.reasoning_*` events are ignored rather than throwing.
- `stream.ts` (`beginWait`): it opens the bubble the turn will write into and dates the frame
  with the segment's id; the first token lands on that same bubble; a call after a tool or after
  prose announces its own; a finished run announces nothing.
- `live-turn.ts`: the wait is replayed mid-call and forgotten with its bubble.
- `subagent-stream.ts`: the child's reasoning reaches the child's own thread, through the streamer of
  the moment; no streamer, no stream.
- `run-sink.ts`: the run's own sink carries the reasoning, the count and the wait, read through the
  streamer that is open now -- and a folded message announcing its own calls is asserted to be
  impossible: a run's calls reach the run's sink, a folded message's sink hears nothing
  (`tests/e2e/injection.test.ts`).
- `reasoning-count.test.ts`: each call reports its count once, before its tools open their cards;
  the log keeps it on the phase, a silent one included; a sink that throws does not stop the run.
  `reasoning-stream.test.ts`: the count lands on its call's bubble without sealing it, opens none of
  its own after an answer, opens and closes no span. `reasoning-codex.test.ts`: the count comes off
  the completed response, a silent thought is timed by its reasoning item, a worded one by its
  first delta. `usage-capture.test.ts` and `anthropic.test.ts`: the count on the other two wires.
- `call-start-hook.test.ts`: every call of a streamed run is announced on its own sink before its
  first token, a sink that throws does not take the run down, and the call names its session.
- `first-output.test.ts`: a call reports how long it took to say anything, once, at the first word
  of reasoning rather than at the answer; the log keeps it on the phase; a sink that throws does not
  stop the run; a call that produced nothing still reports its wait.
- App: `turnWait.test.ts` (the frame starts the line, every content frame and the run end take it
  down, a replay does not redraw it, the measured figure replaces the counter), `waitLine.test.tsx`
  (the counter is formatted from the server instant), `waitLine` in the app suite (the screen draws
  it in the bubble the call opened).
- `claude-sdk/backend.ts`: `thinking_tokens` reaches `onTokens`; `text_delta` still reaches
  `onToken` and never `onText`.
- `stream.ts`: reasoning before any text opens the bubble; a tool seals and resets the accumulator;
  a reasoning-only bubble survives `finish`; `minCharsBeforeDelta` does not delay reasoning; order
  under concurrent pushes.
- **The leak tests**: an assistant mirror message carrying `reasoning` produces a prompt without it,
  through `toChatMessages` and through `renderPriorConversation`.
- `sessions.ts`: history replay carries `reasoning` and `reasoningTokens`, and a turn without
  either replays without the field. A fifty thousand character chain survives the round trip whole.
  A turn carrying `segments` replays as one entry per phase, a last phase that only thought is kept,
  and a thought with no answer at all no longer leaves its tool card alone.
- `provider.ts` and `codex.ts`: two thinking phases in one response report the cuts, one phase
  reports none, and `content` still comes back whole either way.
- `reasoning-segments.test.ts`: the streamer's bubbles and the stored phases match, event order for
  event order.
- the leak tests again: `segments` carries the same display-only text, so the prompt is asserted to
  hold neither it nor the sentinel inside it. A hook-rewritten answer stores no cuts.
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
- Reasoning for sub-agent runs **in the parent's thread**.
- Search or export of reasoning text.
