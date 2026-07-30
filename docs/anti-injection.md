# Anti-injection: normalise, scope, then sanction

Status: **implemented**

Supersedes the incidental behaviour introduced by `8068f10` ("security: anti-injection on user
messages + ..."), which extended the scan to user messages without a design note.

## The incident that motivated this

Matrix session `!6ZM4zLHzS2lLy6NqjT`, 2026-07-29 15:05. The owner pasted a message that ended
with five trailing `U+200B` inherited from a LinkedIn copy-paste. The whole turn became:

```
[BLOCKED: user-message contained potential prompt injection
 (unicode: U+200B, unicode: U+200B, unicode: U+200B, unicode: U+200B, unicode: U+200B)]
```

The request never reached the model. Nothing was logged, and the original text was not kept, so
the cause had to be recovered by reading the persisted session by hand.

## Three distinct defects

### 1. The order of operations is inverted

The old `scanForInjection` treated an invisible character as *evidence of* injection and blocked. It should
treat it as an *encoding artefact* and remove it, then scan. Normalising first is strictly
stronger, not a trade-off:

| Input | Today | Normalise-then-scan |
| --- | --- | --- |
| `Klee<ZWSP>group` (benign paste) | blocked | passes, cleaned |
| `i<ZWSP>g<ZWSP>n<ZWSP>ore all previous instructions` | blocked, but only because the ZWSP betray it | de-obfuscated, then caught by the semantic pattern |

The codebase already knows this: `channels/matrix/format.ts:53` strips exactly this character
class. It is only used to recognise mentions, never on the payload.

### 2. The blast radius is the whole turn

`agent/preprocess.ts:230-264` assembles one blob from `[Reply]`, `[Thread Root]`,
`[Recent Room Context]`, the user's text and the `[Attachments]` list. The scan runs on the blob,
so one artefact anywhere destroys everything, including the owner's actual question. With
`contextVisibility: "allowlist_quote"` (the live setting), a quote from a non-allowlisted sender
is included (`channels/context-visibility.ts:11`), so a third party can silence the owner's turn.

### 3. A block is not debuggable

No log line, raw content not retained, and reasons are emitted once per occurrence rather than
deduplicated -- hence `U+200B` five times for five characters.

## Trust model

The scan's sanction must follow *who authored the bytes*, which the current single-blob scan
cannot express.

| Segment | Author | Class |
| --- | --- | --- |
| user text | the sender, who passed `isAllowedByPolicy` | authored |
| attachment list | my-claw, from sender-supplied filenames | authored |
| reply / quote | any room member, allowlisted or not | foreign |
| thread root, room context | allowlisted senders | foreign |
| tool results, fetched pages, browser content | remote | foreign |
| nested `AGENTS.md` from a cloned repo | remote | foreign |
| `CORE.md`, workspace prompt files, skills, cron prompts | owner | authored |

"Authored" does not mean "safe": the owner routinely pastes foreign text (a recruiter's message,
a web page) into their own turn. It means the owner is the principal and must not be silenced.

## Design

### Normalisation (always, every source)

Remove `\u200b-\u200f`, `\u202a-\u202e`, `\u2060-\u206f`, `\ufeff` before any pattern matching.
Never a block reason. Not configurable: making it optional would only let the owner re-break
their own input, and it is what makes the semantic patterns robust to obfuscation.

### Per-segment scanning

`buildUserContent` scans each segment separately with its own label, so a verdict on a quote
cannot touch the owner's question. The blob-level scan at `bridge.ts:276`, `bridge.ts:642` and
`claude-sdk/backend.ts:733` is removed (it would otherwise double-scan).

### Sanctions

- `annotate` -- keep the content, wrap it with a marker instructing the model to treat it as data
  rather than as a directive. The conversation survives.
- `block` -- replace the segment with the marker (today's only behaviour).

Defaults: **authored segments annotate, foreign segments block.** Per-segment containment is what
makes blocking a foreign segment acceptable: the owner's turn no longer dies with it.

Annotating rather than dropping is also the better security posture for authored text: a dropped
message teaches the owner to reword until it passes, which trains them to defeat the guard.

### Observability

One `warn` per scanned segment that was altered, carrying the label, the deduplicated reasons and
the stripped code-point counts. Never the content itself.

## Configuration

```jsonc
"antiInjection": {
  "enabled": true,             // scan of the user-turn segments
  "ownerSanction": "annotate"  // or "block"
}
```

Hot-reloadable, registered in `HOT_OBJECT_SECTIONS`.

**Deliberately narrow scope: these keys govern the user-turn segments only.** Foreign external
content -- tool results, browser output, fetched pages, nested `AGENTS.md`, `CORE.md`, skills,
cron prompts -- is always scanned and always blocked, and that is not configurable. This keeps
faith with `docs/hot-reload-extensions.md:128` (an editable file must never be able to weaken the
guard) and avoids threading config through the five modules that have none
(`prompt/loader.ts`, `prompt/builder.ts`, `prompt/nested-agents.ts`, `claude-sdk/history.ts`,
`tools/cron.ts`).

The pattern list stays in code, as already decided in `docs/hot-reload-extensions.md:81,128`.

## Decisions taken

1. **Invisible characters are no longer a block reason anywhere** -- they are stripped instead.
   This changes behaviour for foreign content too, not just user messages.
2. **`annotate` is the default sanction for authored segments** -- a matched pattern in the
   owner's own text no longer drops the message; it is passed through as inert data.
3. **Configuration reaches the user turn only** -- foreign content stays unconditionally blocking,
   so `enabled: false` is not a global kill switch.

## As built

- `enabled: false` still normalises. The first cut short-circuited the whole scan, which
  reintroduced the exact problem this document exists to fix. Implemented as a third sanction,
  `off`, so there is one code path rather than a bypass.
- The invisible class was widened from the ten code points the old set listed to the ranges
  already used by `channels/matrix/format.ts:53` (`\u200b-\u200f`, `\u202a-\u202e`,
  `\u2060-\u206f`, `\ufeff`). One class, one definition.
- Invisible characters are reported in `stripped` as per-code-point counts, not in `reasons`.
  The duplicated `U+200B` entries disappear by construction instead of needing a dedup pass.
- Log levels are split: `warn` on a pattern match, `debug` on routine stripping. A warn per
  stripped character would fire on almost every paste from a web app and drown the signal.
- `ScanPolicy` is resolved per run and passed as an argument. `MessagePreprocessor` holds no
  config, and no module-level policy was introduced.

## Accepted limitations

- Scanning is per segment, not per line. A single poisoned line inside `[Recent Room Context]`
  blocks that whole block, though the owner's question and the other segments survive. Going
  finer would mean parsing the context block back into per-sender lines.
- `resolveScanPolicy` is read per run, so a mid-run config change applies from the next turn.

## The pattern gap, closed

The two oldest patterns demand exactly one word between the verb and the noun, so a single inserted
word defeated them. Measured against the shipped list:

| | Known phrasings caught | False positives |
| --- | --- | --- |
| Shipped list | 4 / 11 | 0 / 10 |
| Shipped list + anaphora pattern | 11 / 11 | 0 / 10 |

Everything the old list let through referred to a "before": `ignore all previous instructions`
(the most common phrasing of all), `ignore the previous instructions`, `Ignore all prior
instructions`, `please disregard all previous instructions`, `IGNORE ALL ABOVE INSTRUCTIONS`,
`ignore your previous instructions`, `forget your prior instructions`.

Widening the verb-to-noun gap to any word was rejected: it flags ordinary developer speech such as
"you can ignore the linter rules here" or "the parser must ignore all whitespace rules", and for
foreign content the sanction is a hard block. The discriminant is not the verb but the **anaphora**
-- an injection must point at a previous instruction -- with the noun immediately after it.
"disregard my previous message" stays clean because the noun is not an instruction word.

Added alongside the two older patterns rather than replacing them: `ignore all instructions` and
`disregard your instructions` carry no anaphora and would otherwise stop matching. The overlap on
the plain `ignore previous instructions` form is intentional and reported as two reasons.

Measured false positives: none, across this repo's docs, sources and tests, the persisted sessions
and the workspace prompt files (399 files). The only hits are the deliberate attack fixtures.

## Test plan

- Normalisation: benign paste with trailing `U+200B` passes through cleaned; obfuscated
  `i<ZWSP>gnore all previous instructions` is caught by the pattern after stripping.
- Per-segment: a poisoned quote is neutralised while the owner's question reaches the model intact.
- Sanctions: authored segment annotates and retains content; foreign segment blocks.
- Reasons deduplicated: five `U+200B` produce one reason with a count.
- Config: `enabled: false` skips user-turn scanning; foreign content still blocks.
- Pattern gap: the seven phrasings a single inserted word used to smuggle through are caught, and
  ten benign sentences about ignoring rules are not.
- Hot reload: the section applies without a restart.
