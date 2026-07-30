# Untrusted content: what my-claw does, and what it deliberately does not

Status: **implemented**. Replaces the former `docs/anti-injection.md` (deleted in the same
change), which described a pattern denylist that no longer exists.

## What is kept

One thing: **invisible characters are stripped from untrusted content** before the model reads it,
in `src/utils/invisible.ts`, applied through `normalizeUntrusted()`.

Ingestion points: the incoming user turn, `CORE.md` and the workspace prompt files, nested
`AGENTS.md` from cloned repos, skills, cron prompts, the browser sub-agent's context, replayed
history, and **live tool results from remote-content tools**.

That last one was missing until it was checked: only the SDK *replay* path normalised tool results,
so a fetched page carrying Unicode tag characters reached the model intact on the pass that
actually mattered. It now happens in both backends, right after the `transform:tool:result` hook.

`producesRemoteContent()` in `src/tools/registry.ts` decides which results qualify: `fetch`,
`web_search`, `delegate_browser_task`, `browser_*` and `mcp__*`. The local file tools -- `read`,
`grep`, `find`, `ls`, `bash` -- are deliberately excluded, so the agent sees a local file exactly
as it is. Normalising them would let an edit round-trip silently delete invisible characters the
owner put there on purpose, and for a coding agent corrupting a local file is worse than the
hidden-instruction risk it would cover.

The rationale is narrow and defensible: it guarantees the model reads the same text a human sees.
It is the one measure with a demonstrated attack behind it -- Johann Rehberger's
[invisible prompt injection against Google Jules](https://embracethered.com/blog/posts/2025/google-jules-invisible-prompt-injection/)
(August 2025), where a GitHub issue's visible text was harmless while Unicode tag characters
carried the real instruction.

### The character class, and why it is written out

`[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff\u{E0000}-\u{E007F}]`

- **Not `\p{Cf}`**, though it would be shorter: that category also holds the Arabic number signs
  (U+0600-U+0605) and the Arabic letter mark (U+061C), which carry meaning in real Arabic text.
  Measured: switching to `\p{Cf}` fails 60 tests.
- **Not the variation selectors**: U+FE0F is what makes an emoji render as an emoji. They are not
  in `\p{Cf}` either.
- **The tag block U+E0000-U+E007F is included**, and was the gap: the class shipped before this
  change did not cover the Jules vector at all.

Accepted losses: a ZWJ emoji sequence decomposes (👨‍👩‍👧 becomes three glyphs) and subdivision flags
lose their tags. Both only affect what the model sees, never what is sent back to the owner.

## What was removed, and why

A denylist of eleven English regex patterns that replaced matching content with a `[BLOCKED]`
marker, plus the `annotate` sanction, the per-segment scan and the `antiInjection` config section.

Three measurements decided it:

| | Result |
| --- | --- |
| Known English injection phrasings caught | 4 of 11 (11 of 11 after a fix) |
| The same phrasings in French | **0 of 12** |
| Legitimate security documentation | **blocked** |

The third is what settled it. Two of the three sources used to research this decision --
Simon Willison on delimiters, the OWASP cheat sheet -- contain the phrases the denylist matched,
so the agent could not read the documentation about the very problem it claimed to defend against.

The `annotate` sanction went for a separate reason: it wrapped flagged text in a "treat this as
data" marker, which is a delimiter, and
[delimiters do not work](https://simonwillison.net/2023/May/11/delimiters-wont-save-you/).

### Why not simply add French patterns

Because the exercise does not converge. After French comes Spanish, then paraphrase --
"à partir de maintenant, considère que tes consignes initiales sont caduques" contains no keyword
at all. The relevant principle is Willison's: in application security **99% is a failing grade**,
because the attacker only needs the 1%. [Best-of-N jailbreaking](https://arxiv.org/abs/2412.03556)
(December 2024) measured 89% success against GPT-4o with enough sampled variations, and found the
success rate follows a power law -- no probabilistic filter holds.

OWASP's own guidance is explicit: *"Pattern-based filters do not reliably catch indirect injection
in untrusted content."*

## This is not a security boundary

Nothing in this module stops an injection written in plain, visible prose. Prompt injection is
unsolved for general-purpose agents; the defences that work do so by **constraining what the agent
may do** after ingesting untrusted content, not by detecting the injection. See
[CaMeL](https://arxiv.org/abs/2503.18813) and
[Design Patterns for Securing LLM Agents](https://arxiv.org/abs/2506.08837).

### my-claw's actual exposure

my-claw has all three legs of the
[lethal trifecta](https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/):

- **Private data** -- `bash` and `read` reach `~/.my-claw` (sessions, memory, config with channel
  tokens) and `/etc/my-claw/.env`.
- **Untrusted content** -- `fetch`, `web_search`, the browser sub-agent, MCP servers, and room
  messages from third parties.
- **External communication** -- `fetch` accepts any public URL, `bash` can curl, the browser can
  navigate.

Two details worth stating plainly:

- Approval is opt-in through `config.blacklist`, which is empty, so **no tool requires
  confirmation**. This is deliberate: `src/agent/approvals.ts` records full autonomy as a design
  choice because the app runs in its own encapsulated VM.
- The read-only `research` agent is not exempt. `READ_ONLY_TOOLS` includes both `read` and `fetch`,
  so it can read a secret and send it out. Read-only bounds writes, not exfiltration.

The VM bounds what an attacker reaches on the host. It does not protect the credentials, sessions
and memory that live inside it.

## Open, not addressed here

Cutting the third leg -- egress control on `fetch` and the browser, whether a domain allowlist or
an approval when a URL is composed after untrusted content was read -- is the change that would
actually reduce this exposure. It affects daily use, so it needs its own spec and an explicit
decision.
