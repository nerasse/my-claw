---
name: web-browsing
description: Delegate web browsing tasks (forms, searches, accounts, booking) to a specialized subagent.
---

# Web Browsing

`delegate_browser_task(url, instructions)` hands a task to the browser subagent, which drives the
one shared Chromium: it navigates, fills forms, uploads files, handles dialogs and downloads, and
returns a summary with its screenshots.

This skill is for whoever hands a task to the browser. If you are the browser agent, it is not
yours: you drive the page with your own `browser_*` tools, and you never delegate.

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
   release kept windows with `delegate_browser_task(kept="release", window)`
   (`kept="list"` shows them); the owner has `/windows`.

## Choosing the model

The run uses the browser agent's own model (`config.agents.browser.llm.defaultModel`) unless the
call names another one:

```
delegate_browser_task(url, instructions, model: "tag:Cheap")
delegate_browser_task(url, instructions, model: "synthetic/hf:deepseek-ai/DeepSeek-V4.1-Flash-1017")
```

- **Tags first** (`tag:Medium`, `tag:Cheap`, ...): a route the owner maintains, with its own effort
  and fallbacks. They are the stable names; the catalog behind them moves.
- A bare model id (`provider/model`) pins that model for the run. The catalog is large, so it is
  not enumerated anywhere: the ids that are runnable now are what the picker offers, and a wrong
  one comes back with the five ids that look most like it and the tags.
- **Leave it out** for ordinary work: the agent's pin already is the owner's choice, and a task
  that does not need a special model should not spend one.
- **Reach for a tag when the task's difficulty is the point**: `tag:Smart` for a booking flow with
  many branches, `tag:Cheap` for a long, mechanical sweep (a hundred listings to read).
- The pick sticks to the run: if the agent is stopped mid-task and continued with `send`, it keeps
  the model it started on.
- How to see which tags and ids exist on this install, and how to pick one from the shape of the
  task: read `references/models.md`.

## Downloads come back as files, not as a click

A task that produces a file (a report, an invoice, a paper) ends with a path you can use. Say
explicitly in the instructions what to name it and where it belongs: the page's own name is
often unreadable or truncated, and the browser agent can only choose it if you say so.

> Download the PDF of this article and save it as `hobart-2023.pdf` in `papers/`.

The browser agent reports the real type and size of what it saved, and flags a `.pdf` that is
actually an HTML page (a login wall, an error page) instead of claiming success. Relay that.

## The browser persists

Windows, tabs and logins stay open between tasks: the subagent is told which windows are open and
free, and reuses one already on the right site instead of opening a duplicate. The user can ask to
continue on a page opened earlier. To count or tidy tabs, delegate it. Details, rules and common
errors: read `references/shared-browser.md`.
