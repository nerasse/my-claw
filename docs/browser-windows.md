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
- **No cap, anywhere.** The owner removed every concurrency cap (sub-agents included), then every
  browser one (2026-09-26: "Il faut éviter tout blocage ou limitation. Au pire les navigateurs lag
  avec moins de RAM, c'est un souci pour l'infra"). See "Nothing is capped" below.

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
| Chromium window ids | large, not reused across launches (e.g. 552585005, 1962074506): the tools show short aliases (1, 2, 3...), assigned for the life of the server. A browser restart cannot hand an old id to a new window, so a hold needs no browser epoch |
| memory | about 220 MB of RSS per extra window on a real page (Wikipedia) |

## Windows and tabs a site opens by itself

`target=_blank` and `window.open(url)` open a tab in the **same** window, with `opener` set to the
page that clicked. `window.open(url, "", "width=..,height=..")` opens a **new** window, `opener` set
too. Neither is ever refused: they are what a click did, not a decision.
A window a site opened belongs to the run that holds the window of its opener, and a tab born
inside a held window is that run's.

## Nothing is capped

- **No window cap.** Runs open as many windows as they need (it was 8 agent windows until
  2026-09-26; it was never reached). Closing what is no longer needed is `browser_close_window`.
- **No sweep.** Nothing closes a tab behind anyone's back (it closed idle agent tabs past 12). Tabs
  and windows persist between runs until someone closes them.
- **Nothing a page gives back is cut by the sidecar**: `browser_text`, `browser_eval`, `browser_cdp`,
  `browser_response`, `browser_fetch`, `browser_find`, `browser_network` and the snapshot's refs
  (400 until then) come back whole, and the per-page response log keeps every JSON response. A long
  result is the agent loop's to handle, as for every tool: past the live ceiling (60 000 chars) the
  run sees the start and the file with all of it, which `browser_read_output` reads to the end.
  That tool reads the run's own results and nothing else: the browser agent reads untrusted pages
  all day, so it gets no path to the rest of the disk (`.env` included).
- **A wait is as long as asked**: `browser_wait_for` and `browser_download` take any `timeout_ms`
  (30 s and 120 s ceilings until then), and the client's HTTP budget follows it.
- What stays bounded is time per call (the per-endpoint budgets), which is what keeps a call from
  hanging forever, and the machine: memory is an infrastructure concern (about 220 MB per window).

## A frozen tab

A page stuck in its own JavaScript (a loop that never yields: a careers site did it on 2026-09-26)
answers nothing a tool sends it, for as long as it lives, and holds a CPU core. Measured on
Chromium 147 / Playwright 1.62.1, on that tab:

| call | result |
|---|---|
| `page.title()`, any evaluation, a snapshot | never returns |
| detaching a CDP session from it | never returns |
| `connectOverCDP` while it is open (a sidecar restart) | never returns, since the connection attaches to every tab |
| `Target.getTargets`, `Browser.getWindowForTarget`, `bringToFront`, closing it | a few ms |
| another window, the same site included: navigate, click, screenshot | normal |
| closing it | about 0.5 s before it is gone, while the browser gives up on its renderer |

In production the window listing asked every tab its title, so one frozen tab made it time out 80
times in forty minutes, for every run on every site. Hence:

- **Listings never ask a page.** `list-windows` and the app's `tabs` read the browser's own list
  (titles and urls included); openers come from Playwright's memory, which asks the page nothing
  either (the browser's list drops the opener of a `target=_blank` link, which Chromium opens
  noopener). Adopting a page no longer waits for its CDP session to detach.
- **A call that runs out of time on a page probes it** (`Runtime.evaluate("1")` over a socket of
  its own, 3 s). Frozen: the tab is closed and the run told to reopen its url in a new tab. Alive:
  the page is only slow, and nothing is closed; Playwright's own timeout message, which says what it
  waited for, is kept as it is.
- **A sidecar that cannot connect** waits 10 s, probes every tab, and reports the frozen ones; the
  server closes them and the call goes through (the pending connection completes the moment they
  are gone: measured).
- **A tab a human was handed is never closed**, frozen or not (owner, 2026-09-26: never close a tab
  an agent is waiting on the user for): a tab in a window kept after `needs_human`, for as long as
  the hold lasts. The run is told the tab was left open; at a reconnection the caller is told the
  browser waits on it, and the tab becomes closable when the hold ends.
- A popup opened without `noopener` shares its opener's renderer, so a popup that freezes freezes
  its opener with it (measured): both are frozen tabs, and are treated as such.
- The decision is the server's (`BrowserClient.call`), because only the windows know which tabs a
  human was handed; the sidecar only probes and closes.

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
  back. A frozen tab would stop that reconnection: see "A frozen tab". The sidecar sessions (`/session`, `/cleanup`) are gone: they only carried a current page,
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
| holds, aliases, each run's page per window, handoff hold, `keptForHuman` | `src/tools/browser/windows.ts` (`BrowserWindows`) |
| a frozen tab: probe, close, keep the human's | `src/browser/client.ts` (`call`), `sidecar/browser.mjs` (`responsive`, `frozenPages`, `closeTarget`, the connect budget) |
| a run's long results | `src/tools/browser/output.ts` (`browser_read_output`) |
| run start and end | `src/subagents/runner.ts` (`beginRun` before, `endRun` in the `finally`), through `BrowserSession` |
| the `window` parameter on every page tool | `src/tools/browser/state.ts` (`windowed`) |
| `browser_list_windows`, `browser_new_window`, `browser_close_window`, tabs by window | `src/tools/browser/navigation.ts` |
| the windows in the task | `src/tools/browser/delegate.ts` (`describeWindows`) |
| the rules the agent follows | `src/agents/builtin/browser.md`, rule 0 |
| `create-window`, `list-windows`, `close-window`, a new tab in a given window, the focus lock, adoption of every page, the file chooser | `sidecar/handlers.mjs`, `sidecar/browser.mjs` |

The refusal text is where the fallback is spelled out, the listing is where the choice is made, and
the prompt carries the strategy: each place says only its part.

## Out of scope

- The VNC view, done since in `docs/browser-live.md`: one window on the screen, the others parked
  off it, and the owner picks it from the app.
- Two runs working the same account on the same site at the same time may trip that site's
  anti-abuse. Nothing here prevents it.

## Left out

- **Taking windows back on a `send`** (plan F12): after a normal end, a run's windows are free, and
  a `send` to the same browser agent starts from what is free like any run. Of 348 browser sessions
  up to 2026-09-26, none was ever continued, so there is nothing to take back yet. The handoff case,
  the one that matters, is covered by the hold.
