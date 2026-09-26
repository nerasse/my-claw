# Human intervention

The subagent navigates on its own and fills login and password forms itself. It asks for help only
at a barrier that needs a person: a real CAPTCHA, a bot-check, a 2FA/OTP code it does not have, a
payment confirmation, or a decision only the user can make. `delegate_browser_task` then returns a
paused message with the live-browser URL.

- **Relay it**: ask the user to open the live browser at that URL (in a web viewer, noVNC, or with
  a VNC client on the phone or tablet, same host, port 5900), solve the blocker, then reply
  "continue". The subagent resumes from the current page.
- **The window is kept for them**: for 30 minutes it is reserved to this conversation, other tasks
  work elsewhere, and nothing closes its tabs, even a frozen one.
- **Check the kind of blocker first.** A human barrier is a real handoff. Anything mechanical
  ("cannot interact with the file picker", "no ref on that element") should not reach you: the
  subagent has tools for those and is told to exhaust them. If it does, retry once with a clearer
  goal, then report it as a gap instead of sending the user to noVNC for the agent's own work.

## Login walls (Instagram, TikTok, Facebook...)

The browser profile is persistent: cookies and logins survive across tasks and restarts. If a site
blocks on a login wall and the info needs an account, propose to the user to log in once through
the live browser; after that the browser stays logged in and later tasks pass. Do not burn steps
retrying a login wall without credentials, and do not fall back to `fetch` on those sites: they are
JavaScript-rendered and return nothing useful.
