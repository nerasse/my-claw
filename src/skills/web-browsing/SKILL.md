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

For simple single-page reads, use `fetch` instead (faster and cheaper). `fetch` converts
HTML to readable text and returns it in windows (~50K chars); if a page is long, page
through it by re-calling `fetch` with the `offset` shown at the end of the output — do not
assume the first window is the whole page. The browser sub-agent costs real time and
tokens, so reach for `fetch`/`web_search` first and delegate to the browser only when they
genuinely cannot get the info.

**Never drive the browser yourself.** No `chromium`, `playwright`, or screenshot tooling via
`bash`. The browser is a managed service (CDP on :9222) and `delegate_browser_task` is the
only supported way in — a direct `bash` path bypasses the sandbox, the guardrails, and the
audit trail. On an infrastructure error (CDP/sidecar unreachable), report it to the user; the
managed browser self-heals, so there is nothing to improvise.

**There is no exception any more.** The subagent owns the whole ladder itself — dropdowns,
file uploads through the native dialog, keyboard, scrolling, hovering, dragging, clicking by
position when an element has no ref, waiting, dialogs, downloads, PDF export, and (when the
owner enables them) JavaScript evaluation and raw CDP. So a mechanical blocker is a bug or a
missing capability to report, never something for you to work around with `bash`.

## Parallel tasks

Tasks run at the same time on the one shared browser, each in windows of its own, even on
the same site. Split independent targets into parallel calls; keep steps that depend on each
other (log in, then act) in one task.

## Writing the instructions

The subagent sees only the URL and your instructions — not your conversation, not your
workspace. So put everything it needs in the text:

- **Values, spelled out**: exact name, username, email, date ("July 25, 1997" — not "his
  birthday").
- **File paths, absolute**: to upload a picture, resolve the file first and pass the full path
  (`/home/.../workspace/assets/claw.png`). The subagent cannot search your workspace.
- **The goal, not the clicks**: "set the profile photo to <path>", not "click ref 41 then...".
  It re-reads the page after every action; a click-by-click script goes stale immediately.
- **A verifiable end state**: "confirm the new photo shows on the profile" gives it a way to
  know it succeeded and gives you a trustworthy summary.

## Login walls (Instagram, TikTok, Facebook...)

The browser profile is **persistent** — cookies and logins survive across tasks and
restarts. If a site blocks on a login wall and the info genuinely requires an account:
propose to the user to log in ONCE via the live browser (noVNC); after that the browser
stays logged in and future tasks pass. Do not burn steps retrying a login wall without
credentials, and do not fall back to `fetch` on those sites — they are JavaScript-rendered
and return nothing useful.

## How it works

1. A browser subagent opens the URL in the remote Chromium instance (CDP :9222 on Xvfb :99),
   driven by a Node sidecar (Playwright runs there, not in the main process)
2. It navigates, clicks, types, and takes screenshots; each interactive element gets a ref number
3. After each action it snapshots the page to verify progress
4. It returns a summary when done, or calls `browser_done(needs_human=true)` if it hits a blocker it cannot pass

## Results & screenshots

Screenshots the subagent captures are **automatically attached to your response** and
delivered to the user. You do NOT need to (and must NOT):

- run `find`/`read`/`ls` to locate the screenshot files (they live in a temp dir, and there is
  no need: they are attached for you), or
- reference them with `MEDIA:` (they are already attached).

Just use the summary returned by `delegate_browser_task` to describe the result in your reply.
The images are sent for you.

## Windows are persistent and shared

There is ONE shared browser (not a throwaway instance per task). Windows and tabs stay
OPEN between tasks — they are not closed when a task finishes. So the user can ask you to
continue on a page you opened earlier, and you can.

- The subagent is told which windows and tabs are open, and which are free, and reuses a
  free one on the right site instead of opening duplicates.
- To answer "how many tabs are open?" or "close/tidy the tabs", delegate it:
  `delegate_browser_task(url, "List the open windows; close the ones about X, keep Y")`.
- Do NOT claim each task is an isolated instance, and do NOT inspect processes with `bash`
  to count tabs — just delegate.

## Human intervention

The subagent navigates autonomously and fills login/password forms itself. It only asks for
help when it hits a barrier that genuinely needs a person: a real CAPTCHA, a bot-check, a
2FA/OTP code it does not have, a payment confirmation, or a decision only the user can make.
In that case `delegate_browser_task` returns a paused message with the live-browser URL.

- When you get that paused message, relay it: ask the user to open the live browser at the
  given URL — in a web viewer (noVNC), or with a VNC client on the phone/tablet at the same
  host, port 5900 — solve the blocker, then reply "continue"
- The subagent resumes from the current page
- **Check what kind of blocker it is first.** A human barrier (CAPTCHA, 2FA, payment, a decision
  only the user can make) is a real handoff — relay it. Anything mechanical ("cannot interact
  with the file picker", "no ref on that element") should not reach you: the subagent has tools
  for those and is told to exhaust them. If it does, report it as a gap instead of sending the
  user to noVNC for something the agent should be doing itself.

## Rules

- Never ask the subagent to handle banking PINs or critical passwords
- If a site requires login credentials the agent does not have, ask the user first
- The subagent only has browser tools — no bash/read/write/memory, to prevent side effects
- Its browser toolset grows over time; do not assume a fixed list, and do not tell it which
  tool to call. Describe the goal, not the mechanics
- Its actions (navigate/click/type) return a fresh page snapshot, and it dismisses
  cookie/consent overlays before screenshotting
- The handoff decision is the subagent's own judgment — there is no keyword auto-block

## Session persistence

**With `delegate_browser_task`:** YES. The CDP session stays alive during the entire subagent flow. You can navigate, click, type, and capture within a single continuous session.

**Without (bash direct):** NO. Each `bash` command spawns an isolated process. There is no state shared between separate tool calls.

## Common errors

| Error | Cause | What to do |
|---|---|---|
| ALSA audio warnings | Headless Chromium without a sound card | Benign. Ignore — does not block rendering or navigation. |
| "Browser infrastructure is unavailable" | The sidecar or Chromium is unreachable (CDP/websocket) | Report it to the user. Never improvise with raw `bash` chromium — the managed browser self-heals. |
| Paused for a *mechanical* reason (upload, untargetable element) | The subagent has tools for all of these, so this is a bug or a genuinely missing capability | Retry once with a clearer, more explicit goal. If it blocks again, report it as a gap — do not work around it with `bash`. |

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
