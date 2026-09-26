# The shared browser

## How it works

1. The browser subagent works in the remote Chromium (CDP on Xvfb :99), driven by a Node sidecar
   where Playwright runs.
2. It navigates, clicks, types and takes screenshots; each interactive element gets a ref number,
   and every action returns a fresh snapshot of the page.
3. It returns a summary when done, or pauses for a human at a barrier it cannot pass.

## Windows are persistent and shared

There is one browser, not a throwaway instance per task. Windows and tabs stay open between tasks,
and nothing closes them behind anyone's back.

- The subagent is told which windows and tabs are open, which are free, and which another task is
  using. It reuses a free one already on the right site instead of opening a duplicate, and takes
  another window rather than waiting for a busy one.
- There is no cap on windows or tabs. To answer "how many tabs are open?" or to tidy them,
  delegate it: `delegate_browser_task(url, "List the open windows; close the ones about X, keep Y")`.
- Do not claim each task is an isolated instance, and do not inspect processes with `bash` to
  count tabs.
- A tab whose page froze is closed when a call on it times out, and the subagent reopens the page
  if it still needs it. A tab kept for a human is never closed.

## What the subagent has

- Only browser tools: no bash, write or memory. It reads its own long results in full with its own
  reader, and nothing else on the disk.
- It dismisses cookie and consent overlays before screenshotting.
- The handoff decision is its own judgment: there is no keyword auto-block.

## Results and screenshots

Screenshots it captures are automatically attached to your response and delivered to the user.
Do not run `find`, `read` or `ls` to locate them, and do not reference them with `MEDIA:`. Use the
summary `delegate_browser_task` returns.

## Common errors

| Error | Cause | What to do |
|---|---|---|
| ALSA audio warnings | Chromium without a sound card | Benign: ignore. |
| "Browser infrastructure is unavailable" | The sidecar or Chromium is unreachable | Report it to the user. Never improvise with `bash`: the managed browser self-heals. |
| Paused for a mechanical reason (upload, untargetable element) | A bug or a missing capability | Retry once with a clearer goal; if it blocks again, report it as a gap. |
