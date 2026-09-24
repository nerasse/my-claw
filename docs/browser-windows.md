# One browser, many windows: parallel browser runs

*2026-09-23. Replaces the one-run-at-a-time queue (`enqueueBrowserTask`). Decided with the owner;
every number below was measured on this host (Chromium 147, Playwright 1.62.1, Xvfb without a
window manager) on a throwaway Chromium, never the production one.*

## Why the queue went

There is one Chromium, and before the queue every browser run drove it through one shared page
pointer: runs clicked in each other's tabs. The queue fixed that by letting a single run near the
browser at a time, which is also what made it the bottleneck: on 2026-09-18 four delegations
issued in one turn waited 0, 8m39, 11m03 and 12m29 for their turn, and a run waiting in the queue
did nothing at all (its model was not even called). Nothing was ever wrong with two runs using the
browser at once, only with two runs using *the same page*.

The page pointer was never per run either, whatever `docs/browser.md` said: `register.ts` handed one
`BrowserPageState` to every tool. The queue was the only thing standing between two runs and one
pointer.

## The model

- **The unit is the window.** Each run works in windows it holds. Two runs never share a window, so
  they never share a tab, a focus or a ref numbering. They can be on the same site: two windows on
  Reddit are two windows.
- **Holding is implicit.** The first browser tool that names a free window takes it for the calling
  run. There is no tool to lock and nothing to remember: the run is told which windows are free and
  that the lock is automatic.
- **A held window never stops anyone.** A tool that names a window another run holds is refused with
  what to do instead: take a free window, or open one, even for the same site. It does not wait,
  and it is not an infrastructure failure (`guardedBrowserTool` must not end the run over it).
- **Release is the run's end.** The runner's `finally` releases every window the run held, whether
  it answered, failed, was stopped or crashed. Holds live in the server's memory only: after a
  server crash they are gone, but so is every run that could have held one. There is nothing to
  clean up at boot, and no hold can outlive its run.
- **A human handoff keeps its window.** A run that ends on `browser_done(needs_human=true)` leaves
  its windows held for its conversation (the `parentSessionId`) for 30 minutes: the owner solves the
  captcha there, and whichever browser run that conversation starts next (a `send` to the same
  agent, or a new delegation) takes them back. Anyone else is refused, like a held window.
- **Every action names its window** (`window`, the short number `browser_list_windows` shows). A run
  may hold several.
- **No cap on runs.** The owner removed every concurrency cap (sub-agents included). What bounds the
  browser is the window cap and the sweep below.

## What a window is

A real Chromium window (`Target.createTarget({ newWindow: true })` from the browser CDP session), in
the one browser context. Measured:

| probe | result |
|---|---|
| windows are distinct, one X window each | yes (`Browser.getWindowForTarget` groups tabs by window) |
| a cookie set in window A is read in window B | yes: one profile, so logins are shared |
| opening a tab *in a given window* | `Target.createTarget` has no window parameter and opens in the last active window. `bringToFront` on a tab of the window then `createTarget`: 50/50 in the right window. The sidecar serialises that pair (and every other `bringToFront`) behind one lock, since a `bringToFront` elsewhere between the two would move the tab. `window.open` from inside the window also hit 50/50, and was not kept: the page's own scripts can replace `window.open`. |
| two windows typed into, clicked and screenshotted at the same time | 20/20 rounds, no crossed input, `document.hasFocus()` true on both |
| a tab behind another tab in its window | `visibilityState` stays `visible`, a screenshot takes 238 ms, a click works, `requestAnimationFrame` runs. Playwright's focus emulation covers it: no `bringToFront` is needed before acting. |
| Chromium window ids | large, not reused across launches (e.g. 552585005): the tools show short aliases (1, 2, 3...), assigned for the life of the server |
| memory | about 220 MB of RSS per extra window on a real page (Wikipedia) |

## Windows and tabs a site opens by itself

`target=_blank` and `window.open(url)` open a tab in the **same** window, with `opener` set to the
page that clicked. `window.open(url, "", "width=..,height=..")` opens a **new** window, `opener` set
too. Neither is ever refused or counted against a cap: they are what a click did, not a decision.
A window a site opened belongs to the run that holds the window of its opener, and a tab born
inside a held window is that run's.

## The cap and the sweep

- At most **8 windows opened by agents** (`browser_new_window`), counted over the ones still open.
  Windows the owner opened, and windows sites opened, do not count. Past it the tool is refused
  with the free windows to reuse.
- Past **12 tabs in the browser**, opening a window or a tab first closes the least recently used
  **agent tabs** that have been idle for 30 minutes, and only in windows nobody holds. A tab that
  was already open when the server started, or that the owner opened, is never closed by the
  sweep: we do not know what it is.

## The native file chooser

Clicking an `<input type=file>` without a Playwright `filechooser` listener opens GTK's "Open File"
window (measured: it appears on the display), whose modal grab is the incident of 2026-09-21
(`src/browser/unblock.ts`): no click anywhere works any more. With parallel runs, one stray click
would freeze every run and the owner's session. Every page therefore gets a permanent
`filechooser` listener (measured: no native window appears, `setFiles` works afterwards). A chooser
a click opened is kept for the page, the next snapshot says so, and `browser_upload_file` uses it.

## The sidecar and crashes

- Pages are identified by their CDP `targetId`, windows by their CDP window id. Both survive a
  restart of the sidecar, so the server's holds and each run's current page stay valid when it comes
  back. The sidecar sessions (`/session`, `/cleanup`) are gone: they only carried a current page,
  which is the server's job now.
- **One sidecar per Chromium.** The sidecar adopts every page as it is born (the file chooser and a
  popup's opener cannot wait for a tool to touch it), so a second sidecar on the same Chromium puts
  a second dialog listener on every page, which auto-accepts before the first one's
  `browser_handle_dialog` override can answer (seen on the e2e suite with a stray debugging sidecar).
  Production runs one, from its unit.
- A renderer that crashes while Playwright attaches to it makes Playwright throw an assertion from
  its connection handler (measured on the spike, an uncaught exception). The sidecar is not
  protected against it; it is `Restart=always` and comes back in seconds, which the identity rule
  above makes harmless. It was never seen in production (0 occurrences since 2026-09-01).

## Where it lives

| piece | file |
|---|---|
| holds, aliases, each run's page per window, cap, sweep, handoff hold | `src/tools/browser/windows.ts` (`BrowserWindows`) |
| run start and end | `src/subagents/runner.ts` (`beginRun` before, `endRun` in the `finally`), through `BrowserSession` |
| the `window` parameter on every page tool | `src/tools/browser/state.ts` (`windowed`) |
| `browser_list_windows`, `browser_new_window`, `browser_close_window`, tabs by window | `src/tools/browser/navigation.ts` |
| the windows in the task | `src/tools/browser/delegate.ts` (`describeWindows`) |
| the rules the agent follows | `src/agents/builtin/browser.md`, rule 0 |
| `create-window`, `list-windows`, `close-window`, a new tab in a given window, the focus lock, adoption of every page, the file chooser | `sidecar/handlers.mjs`, `sidecar/browser.mjs` |

The refusal text is where the fallback is spelled out, the listing is where the choice is made, and
the prompt carries the strategy: each place says only its part.

## Out of scope

- The VNC view: without a window manager it shows the last raised window, so it jumps between
  windows when runs work in parallel. Next step, separately.
- Two runs working the same account on the same site at the same time may trip that site's
  anti-abuse. Nothing here prevents it.
