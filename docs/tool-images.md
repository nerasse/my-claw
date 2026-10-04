# Tool images in the model's context

*2026-09-22. The owner found the gap: "les agents n'arrivent pas à lire les fichiers images... il
faut que read donne la capacité aux LLM de charger des images dans leur contexte, comme si ils
t'avaient envoyé une pièce jointe." A tool's `attachments` only ever reached the client (the app
showed the screenshot); the model never saw it. The two references were read first, at their
latest commits: opencode puts image reading in `read` itself (magic-byte sniff, `attachments` on
the tool result, a user-message fallback for providers that refuse media in tool results), codex
uses a dedicated `view_image` (data URL in the typed output, refused when the model has no image
input). Owner's choices: the image rides the tool result, and every tool with image attachments
deposits them.*

## The rule

**In the conversation, a tool's images belong to its own tool message**, as content parts
(`text` + `image_url`) beside the output text. Nothing is added to the conversation's message
roles, so the entry-to-message pairing the prompt depends on is untouched. Each transport then puts
them where its protocol allows images:

| transport | shape |
|---|---|
| Anthropic | blocks *inside* the call's `tool_result` (`content: [text, image]`) |
| Codex / Responses | `function_call_output.output` items (`input_text`, `input_image`) |
| OpenAI-compatible | the tool message keeps its text; the turn's images follow its last tool result in one `user` message (`liftToolImages`, `provider.ts`) |

## Why chat completions lifts them

*2026-09-24.* The first version sent the parts array on `role: "tool"` for chat completions too,
on the belief that those endpoints take the user-message part shape there. They do not have to:
the spec types a tool message's content as `string | Array<ChatCompletionContentPartText>`
(`openai-node`, `ChatCompletionToolMessageParam`), text only. opencode says the same in its code
("OpenAI-compatible APIs only support string content in tool results") and lifts media into a user
message for exactly those providers.

What made it look fine: a tolerant upstream accepts the parts anyway. OpenCode Go routes each
session (`x-opencode-session`) to one upstream of `deepseek-v4.1-flash`, and some are strict. Same
request, only the session header changed:

| session | image on `tool` | text on `tool` | image on `user` |
|---|---|---|---|
| browser sub-agent `f233eb3d` | 422 `messages.3.tool.content.str: Input should be a valid string` | 200 | 200, reads the image |
| thread `5b626af1` | 422, same | 200 | 200 |
| a fresh session | 200, reads the image | 200 | 200 |

Because the session keeps its upstream, every retry failed identically and the two runs died (one
after 62 tool calls). The 422 was also retried as an outage for three and a half minutes, because
`outage.ts` read OpenCode's envelope "Upstream request failed" as the far side's fault; the
bracketed type inside it (`[invalid_request_error]`) is what tells, and now decides.

The lift is derived from the history on every call, so a given history always sends the same
prefix and the prompt cache holds. The tool results stay contiguous after the assistant that asked
for them (every endpoint checks that), and each lifted image is preceded by the call it came from
(`read (call tc1):`), so the model can tell whose picture it is. A user message carrying images is
the one shape every vision endpoint takes, so there is no per-provider table to keep.

## `read` reads pictures

`read` sniffs the first bytes: png/jpeg/gif/webp magic only, **no extension fallback** (a text file
named `notes.png` must not be sent to a vision API as a picture). An image returns a short line
plus `attachments: [{ type: "image", path, mimeType }]`; the bytes stay on disk and are encoded to
a data URL at prompt build (resized past 2 MB / 2000 px, LRU-cached on `(path, mtime, size)` --
`media/image.ts` via `imageContentFrom`). A binary that is no image is refused in words instead of
returning mojibake from a utf-8 read.

## Budgets

- **Live**: every settled tool's images ride its message for the rest of the run (append-only, so
  prompt cache stays valid). The cost is what the owner accepted when choosing scope.
- **Rebuilt prompts** (a later run, a mid-run compaction): recent-first, tool images have their
  own budget (`MAX_HISTORY_TOOL_IMAGES = 4`) so a run that captures screenshots cannot evict the
  picture the owner sent (`MAX_HISTORY_IMAGES = 4`, unchanged). The pairing is by `tool_call_id`,
  never by position: counting user slots is what once dropped a user's picture on a tool message.

## Persistence

`ToolEntry.attachments` (`SessionAttachment`: image + path + mime) is written at settle by the
same `RunRecorder.tool` that writes the clipped output, so the entry, the card and every later
rebuild agree on what the tool showed the model.

## What the conversation gets

*2026-10-04. The owner saw six `(deleted)` attachments under a reply: the agent had read its own
screenshots to check a layout, then deleted their folder before answering.*

- **Kept from the reply** (`ToolResult.keepFromReply`): `read` of an image is the agent looking at
  a file, so its picture rides the tool message to the model and is not attached to the reply.
  `tts` makes a draft: the agent may listen to it (`stt`) and make it again, and only the take its
  answer names with `MEDIA:` is delivered. A browser screenshot still attaches by itself.

  Why not dedup: a regenerated voice note is the same text and not the same bytes (two Edge
  renderings differ), so the content dedup of 2026-09-23 had nothing to match and the reply
  carried two players (thread 5b626af1, 2026-10-04). Two ways to deliver one file is the fault; a
  tool whose output the answer sends is delivered by the answer alone.
- **Copied when the tool returns, not at the end of the run** (`bridge.ts`, through the channel's
  media store): a file deleted or overwritten later in the run no longer leaves a hole. The id
  rides back onto the attachment, so the end marker and the outgoing frame reuse that copy
  (`storeRunMedia` skips an attachment that has one).

`tests/agent/tool-media.test.ts`.
