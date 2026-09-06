# Attachments

## Two ways to send files

1. **Explicit** — agent writes `MEDIA:/absolute/path` in its text response
2. **Auto** — tool returns `attachments: [{ type, path, mimeType }]` in `ToolResult`

## Rule

If the response text contains `MEDIA:` refs, **only** those files are sent. Auto-attachments are suppressed. If no `MEDIA:` refs, auto-attachments are sent.

This prevents double delivery when both the LLM and the tool reference the same file.

## TTS flow

```
User: "say hello"
Agent calls tts tool → generates /tmp/tts-xxx/output.mp3
ToolResult includes attachment: { type: "audio", path, mimeType }
AgentBridge collects attachments
Router returns { text, attachments }
Cleanup deletes /tmp/tts-xxx after send
```

## Streaming behavior

- Text is sent live token-by-token
- `MEDIA:` refs are stripped from the streamed text as it goes (a ref split across
  tokens is held back whole, so it never flashes on screen)
- Files are sent as programmatic attachments after `streamer.finish()`; the app merges
  that media-only delivery into the bubble that just streamed the answer, so the image,
  video, voice note or file card sits under the words that go with it
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

## Browser screenshots

`delegate_browser_task` → the browser agent's run calls `browser_screenshot` → the bridge of that run collects the attachment (`getResponseAttachments`) → `SubAgentRunner.spawn` returns it → `delegate_browser_task` puts it on its `ToolResult.attachments` → the caller's bridge → router → adapter. The main agent does not need to handle the image; delivery is automatic. Since 0.7 `spawn` returns a sub-agent's produced attachments the same way.
