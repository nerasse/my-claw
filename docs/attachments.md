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

## What a served window owes its pictures (2026-09-15)

A media ref is a *path*; what the device can fetch is a *store id*. The turn from one to the other
happens in `displayOf` (`src/channels/my-claw-app/display.ts`), against the thread's file list --
which costs a directory read, so `MyClawAppSessionStoreImpl` only loads it when the window being
served can carry media.

That condition was the bug. It read "does this window hold a `user` entry, or a phase whose text
contains `MEDIA:`" -- a proxy for the need, copied in three places (the initial page, the delta, a
run's own window). It knew two of the three ways a turn carries media: a tool's pictures ride the
run's **end marker** (`run_end.media`), with no ref anywhere in the prose. A run's own window is
*by construction* the run's entries and never the question that opened it, so every one of its
refs resolved to `deleted: true` with a minted id (`media-0`, `media-1`, ...), and the app drew an
empty stage under a bare filename. Measured on a real thread: the same window resolved 0 of 25
pictures before, 25 of 25 after.

The rule is now asked of the refs themselves, once, next to the display that resolves them:
`windowNeedsFiles` (over `mediaRefsOf`, which uses the same `extractMediaRefs` the resolver does).
Three call sites, one predicate -- and the test that was missing all along goes *through* the
store (`store.sync` / `store.runItems`), not around it: the resolver had tests from the start, and
they all passed a file list in by hand, which is exactly how an incomplete fix stays green.

A delta the client asks for *after* the owner's next message exists comes back resolved: the
window then holds that question. The break is mid-run, and it repairs itself on the next sync or
reopen -- which is why it read as intermittent.
