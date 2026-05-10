---
name: web-browsing
description: Delegate web browsing tasks to a specialized subagent. Use for filling forms, searching websites, checking accounts, booking, or any multi-step web interaction.
---

# Web Browsing

## When to use

Call `delegate_browser_task(url, instructions)` when:
- The user asks to search/retrieve info from a specific website
- The user asks to fill a form, book something, or make a reservation
- The user asks to check an account status on a web dashboard
- The task requires more than 2 sequential web page interactions

For simple single-page reads, use `fetch` instead (faster).

## How it works

1. A browser subagent opens the URL in the remote Chromium instance (CDP :9222 on Xvfb :99)
2. It navigates, clicks, types, and takes screenshots using Playwright over CDP
3. After each action it snapshots the page to verify progress
4. It returns a summary when done, or asks for human help if blocked

## Human intervention

If the subagent encounters a CAPTCHA, login wall, or 2FA:
- It stops and reports `needs_human: true`
- You (the main agent) must ask the user to open noVNC at `http://<host>:6080`
- The user sees the live browser, solves the blocker, then replies "continue"
- The subagent resumes from the current page

## Rules

- Never ask the subagent to handle banking PINs or critical passwords
- If a site requires login credentials, ask the user first
- The subagent only has browser tools (navigate, snapshot, click, type, screenshot)
- It does NOT have bash/read/write/memory tools to prevent side effects
- After every action, the subagent calls `browser_snapshot` to verify state
- If stuck for 3 consecutive steps, it stops and asks for help

## Example flow

```
User: "Book me a train ticket to Lyon tomorrow"
→ delegate_browser_task(
    url: "https://www.sncf-connect.com",
    instructions: "Find next train Paris-Lyon tomorrow morning, select 9am departure, fill passenger info with name John Doe, proceed to payment"
  )
→ Subagent navigates, fills form
→ If CAPTCHA appears → returns needs_human
→ You ask user to open noVNC :6080
→ User solves CAPTCHA, says "continue"
→ Subagent finishes booking
→ Returns summary with booking reference
```
