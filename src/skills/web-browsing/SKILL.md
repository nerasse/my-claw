---
name: web-browsing
description: Delegate web browsing tasks (forms, searches, accounts, booking) to a specialized subagent.
---

# Web Browsing

## When to use

Call `delegate_browser_task(url, instructions)` when:
- The user asks to search/retrieve info from a specific website
- The user asks to fill a form, book something, or make a reservation
- The user asks to check an account status on a web dashboard
- The task requires more than 2 sequential web page interactions

For simple single-page reads, use `fetch` instead (faster).

**Never run `chromium`/`playwright`/screenshot tools via `bash`.** The browser runs as a
managed service (CDP on :9222). Always go through `delegate_browser_task`. If it returns an
infrastructure error (CDP unreachable), report it to the user — do not improvise with raw
`bash` chromium, which bypasses the sandbox and the managed browser.

## How it works

1. A browser subagent opens the URL in the remote Chromium instance (CDP :9222 on Xvfb :99)
2. It navigates, clicks, types, and takes screenshots using Playwright over CDP
3. After each action it snapshots the page to verify progress
4. It returns a summary when done, or calls `browser_done(needs_human=true)` if it hits a blocker it cannot pass

## Human intervention

The subagent navigates autonomously and fills login/password forms itself. It only asks
for help when it hits a barrier it genuinely cannot pass (real CAPTCHA, bot-check, or a
2FA/OTP code it does not have). In that case `delegate_browser_task` returns a paused
message with the live-browser URL.

- When you get that paused message, relay it: ask the user to open the live browser at the
  given URL, solve the blocker, then reply "continue"
- The subagent resumes from the current page

## Rules

- Never ask the subagent to handle banking PINs or critical passwords
- If a site requires login credentials the agent does not have, ask the user first
- The subagent only has browser tools (navigate, snapshot, click, type, screenshot)
- It does NOT have bash/read/write/memory tools to prevent side effects
- After every action, the subagent calls `browser_snapshot` to verify state
- The handoff decision is the subagent's own judgment — there is no keyword auto-block

## Session persistence

**With `delegate_browser_task`:** YES. The CDP session stays alive during the entire subagent flow. You can navigate, click, scroll, and capture within a single continuous session.

**Without (bash direct):** NO. Each `bash` command spawns an isolated process. There is no state shared between separate tool calls.

## Common errors

| Error | Cause | Severity |
|---|---|---|
| ALSA audio warnings | Headless Chromium without a sound card | Benign. Does not block rendering or navigation. |
| "Opening in existing browser session" | Conflicting Chromium process already running in the background | Kill the existing process and relaunch in an isolated headless session. |
| `delegate_browser_task` returns HTTP 400 | The subagent LLM call failed (not the browser itself) | Check that CDP, Xvfb, and noVNC are up. The browser infrastructure is usually fine; the failure is at the LLM delegation layer. |

## Example flow

```
User: "Book me a train ticket to Lyon tomorrow"
-> delegate_browser_task(
    url: "https://www.sncf-connect.com",
    instructions: "Find next train Paris-Lyon tomorrow morning, select 9am departure, fill passenger info with name John Doe, proceed to payment"
  )
-> Subagent navigates, fills form (including login)
-> If a real CAPTCHA appears -> browser_done(needs_human=true)
-> You relay the paused message: user opens the live browser URL
-> User solves CAPTCHA, says "continue"
-> Subagent finishes booking
-> Returns summary with booking reference
```
