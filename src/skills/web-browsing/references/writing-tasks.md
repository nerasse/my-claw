# Writing a browser task

The subagent sees only the URL and your instructions: not your conversation, not your workspace.
Everything it needs has to be in the text.

- **Values, spelled out**: exact name, username, email, date ("July 25, 1997", not "his
  birthday").
- **File paths, absolute**: to upload a picture, resolve the file first and pass the full path
  (`/home/.../workspace/assets/claw.png`). The subagent cannot search your workspace.
- **The goal, not the clicks**: "set the profile photo to <path>", not "click ref 41 then...". It
  re-reads the page after every action; a click-by-click script goes stale at once.
- **A verifiable end state**: "confirm the new photo shows on the profile" gives it a way to know
  it succeeded, and gives you a summary you can trust.
- **No tool names**: its toolset grows over time. Describe the goal, not the mechanics.
- **Never** banking PINs or critical passwords. If a site needs credentials the agent does not
  have, ask the user first.

## Parallel tasks

Independent targets go in parallel calls, one task each: each works in windows of its own, even on
the same site, and a window another task holds is never waited for. Dependent steps stay in one
task, since a second task does not see what the first one did.

## Example flow

```
User: "Book me a train ticket to Lyon tomorrow"
-> delegate_browser_task(
    url: "https://www.sncf-connect.com",
    instructions: "Find the next Paris-Lyon train tomorrow morning, select the 9am departure,
      fill passenger info with the name John Doe, proceed to payment"
  )
-> the subagent navigates and fills the form, login included
-> a real CAPTCHA appears -> it pauses (needs a human)
-> you relay the paused message: the user opens the live browser link
-> the user solves the CAPTCHA and says "continue"
-> the subagent finishes the booking and returns the booking reference
```
