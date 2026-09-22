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

One rule, no provider table: **a tool's images ride its own tool message**, as content parts
(`text` + `image_url`) beside the output text. Nothing is added to the conversation's message
roles, so the entry-to-message pairing the prompt depends on is untouched. Each transport maps the
parts to its native shape:

| transport | shape |
|---|---|
| Anthropic | blocks *inside* the call's `tool_result` (`content: [text, image]`) |
| Codex / Responses | `function_call_output.output` items (`input_text`, `input_image`) |
| OpenAI-compatible | the parts array on `role: "tool"` (the same shape user messages use) |

An endpoint that refuses parts on a tool message is a measured quirk to handle when it is
measured, not a table to guess at (the codebase already papers over per-model refusals in
`provider.ts`, for cache parts).

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
