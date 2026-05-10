# Telegram Commands — Why `bot.hears()` not `bot.command()`

## Problem

grammy's `bot.command()` requires the `bot_command` entity in `msg.entities`.
Telegram clients send this entity for commands typed manually or picked from the
bot menu, but some clients omit it (copy-paste, edited messages, alternate
clients). When the entity is missing, `bot.command()` silently returns `false`
and the update falls through to `bot.on("message")`, causing `/new` to be routed
to the LLM as plain text instead of resetting the session.

## Fix

Use `bot.hears(/^\/new(?:@\w+)?(\s|$)/)` which checks raw message text with a regex,
ignoring entity presence entirely. The `(?:@\w+)?` group also accepts the optional
`@botname` suffix that Telegram appends in groups or that some clients include.
Applied to all commands:
`/new`, `/clear`, `/model`, `/compact`, `/status`, `/archive`, `/help`.

A defensive fallback in `handleMessage` strips `@botname` before matching, so
commands never leak to the LLM even if `bot.hears()` somehow fails.

## Code

```typescript
this.bot.hears(/^\/new(?:@\w+)?(\s|$)/, (ctx) => this.handleCommand(ctx, "new"));
```

## Reference

- grammy source: `Context.has.command()` → checks `msg.entities.some(e => e.type === "bot_command")`
- OpenClaw issue #27012: same root cause
