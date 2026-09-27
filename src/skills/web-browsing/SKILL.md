---
name: web-browsing
description: Delegate web browsing tasks (forms, searches, accounts, booking) to a specialized subagent.
---

# Web Browsing

`delegate_browser_task(url, instructions)` hands a task to the browser subagent, which drives the
one shared Chromium: it navigates, fills forms, uploads files, handles dialogs and downloads, and
returns a summary with its screenshots.

## When to use

- Search or retrieve info from a specific website that needs interaction
- Fill a form, book something, check an account on a web dashboard
- More than 2 sequential page interactions

For a single-page read, use `fetch` first (faster, cheaper): it returns the page as text in windows
of ~50K chars; page through a long one with the `offset` it prints. Reach for the browser only when
`fetch` and `web_search` cannot get the info.

**Never drive the browser yourself**: no `chromium`, `playwright` or screenshot tooling through
`bash`. The browser is a managed service and `delegate_browser_task` is the only way in. A
mechanical blocker (dropdown, upload, element without a ref) is the subagent's to solve with its
own tools, or a gap to report, never something to work around.

## Quick workflow

1. **Split** independent targets into parallel calls: tasks run at the same time on the one
   shared browser, each in windows of its own, even on the same site. Keep dependent steps (log
   in, then act) in one task.
2. **Write the instructions** for someone who sees nothing but the URL and your text: exact
   values, absolute file paths, the goal rather than the clicks, a verifiable end state. Read
   `references/writing-tasks.md`.
3. **Relay the result**. Screenshots are **automatically attached** to your response: do not look
   for the files and do not reference them with `MEDIA:`. Describe the result from the summary.
4. **A paused task** means a human barrier (CAPTCHA, 2FA, payment, a decision only the user can
   make): relay the live-browser link and wait for "continue". Read `references/handoff.md`.
5. **A kept window** means the task stopped on purpose at a step it will come back to (the answer
   says which window, until when, and what is needed). Get what is needed, then delegate the next
   step: the new task is offered that window first. A code the site e-mails is fetched by the
   browser agent itself (`browser_mail_verification`); you only step in when it could not. List or
   release kept windows with `held_browser_windows`; the owner has `/windows`.

## The browser persists

Windows, tabs and logins stay open between tasks: the subagent is told which windows are open and
free, and reuses one already on the right site instead of opening a duplicate. The user can ask to
continue on a page opened earlier. To count or tidy tabs, delegate it. Details, rules and common
errors: read `references/shared-browser.md`.
