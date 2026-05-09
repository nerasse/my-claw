# Attachments

## Two ways to send files

1. **Explicit** — agent writes `MEDIA:/absolute/path` in its text response
2. **Auto** — tool returns `attachments: [{ type, path, mimeType }]` in `ToolResult`

## Rule

If the response text contains `MEDIA:` refs, **only** those files are sent. Auto-attachments are suppressed. If no `MEDIA:` refs, auto-attachments are sent.

This prevents double delivery when both the LLM and the tool reference the same file.

## TTS flow

```
User: "dis bonjour"
Agent calls tts tool → generates /tmp/tts-xxx/output.mp3
ToolResult includes attachment: { type: "audio", path, mimeType }
AgentBridge collects attachments
Router returns { text, attachments }
Cleanup deletes /tmp/tts-xxx after send
```

## Streaming behavior

- Text is sent live token-by-token
- `MEDIA:` refs are stripped from the final streamed text
- Files are sent as programmatic attachments after `streamer.finish()`
- No `MEDIA:` visible to the user

## Non-streaming behavior

- `adapter.send()` extracts `MEDIA:` refs from text, strips them, sends text
- Then sends refs + programmatic attachments as separate media messages

## Deduplication

`adapter.send()` deduplicates `mediaRefs` against `message.attachments` by path. Same file from explicit + auto sources is sent once.

## Configuration

No config needed. TTS auto-attachment works out of the box when `voice` is configured.

## Adding auto-attachments to a custom tool

```ts
return {
  success: true,
  output: "Done",
  attachments: [
    { type: "image", path: "/tmp/out.png", mimeType: "image/png" },
  ],
};
```
