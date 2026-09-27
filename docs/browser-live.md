# The live view: the VNC screen, the wall, the owner's hand

Agents work in many browser windows at once (`docs/browser-windows.md`). The owner has to be able
to see all of them, pick the one a VNC client shows, and lend a hand in any of them from the app,
on a phone as well as on a desk with several screens. None of this may slow an agent down or take
its window.

## The owner holds nothing

Watching a window, putting it on the VNC screen, clicking or typing in it: none of it reserves the
window. An agent working in it keeps working and reads the page again after each of its actions,
as it already does after a page moves on its own. The only reservation a human has is the one an
agent asks for, the handoff (`needs_human`, `HANDOFF_HOLD_MS`).

The owner does not take over while an agent acts, but is never locked out either: a button the
agent cannot find, a consent banner, a captcha, he can press it.

## One VNC screen, one window on it

The VNC server shows one X screen (`:99`, 1920x1080, port 5900). There is no window manager, and
Chromium stacks the last window created on top: before this, every agent opening a tab came up
over the window the owner was solving a captcha in.

Now the screen is a stage (`sidecar/live.mjs`):

- One window stands on it at a time. Every other one is parked to its right, off the screen, with
  `Browser.setWindowBounds`. Measured on Chromium 147 without a window manager: a parked window
  keeps rendering at 61 frames/s, stays `visible`, and takes clicks and screenshots unchanged.
  Parking has no limit, so there is no cap on windows.
- Agents' windows are born off the screen (`Target.createTarget` with a `left` past it), and so are
  the popups of a window off the screen. A popup of the window on the screen stays on it: a "Sign
  in with Google" opened from a captcha page is where the owner is looking.
- The owner's own new window (`browser.control` `new_window`) goes on the screen, alone.
- When the window on the screen closes, the one worked in last takes its place. Otherwise the
  screen keeps what it shows: nothing moves under the owner's eyes unless he asks, or an agent
  hands a window over.
- A handoff puts its window on the screen, and the message to the owner says which window it is.
  Several at once: the last one is shown, the others wait in the app, marked "waiting for you".

Nothing is stored about which window is shown: it is the one whose bounds fall on the screen. That
survives a restart of the server or of the sidecar.

The VNC client stays what it was (same address, same port). It cannot choose a window; the app
does, with "Show in VNC". On a phone the app then opens the client through a `vnc://` link when one
is installed that takes it.

Considered and dropped:

- One VNC port per window: one bookmark per window, a fixed-size X screen each (so a cap), one
  x11vnc per window.
- A window manager with a task bar: unreadable on a phone, and agents would still come up on top.
- One giant X screen spread over several monitors by the VNC client: its size is fixed at start (a
  cap again), and useless on a phone.

## The wall

The app's Browser page shows every window live, as tiles: which agent task holds it, whether it is
free, waiting for the owner, or on the VNC screen, its tabs, and the picture of the tab it shows.
A tile opens the window at full size. The same page serves a phone, a tablet and a desk: the wall
takes as many columns as fit. On the web, "Pop out" opens one window in a browser tab of its own
(`#browser-window=<id>`), so five screens can show five windows.

Pictures come from the CDP screencast (`Page.startScreencast`), per tab:

| use | size | JPEG quality | frames/s at most |
|---|---|---|---|
| tile | 640x360 | 55 | 4 |
| full size | 1600x900 | 70 | 15 |

The screencast sends a picture only when the page changes: a static page costs one picture, an
animated one at 1280 px about 7 KB a picture (22.7 frames/s measured). Five windows, four of them
off the screen, streamed at about 4.8 frames/s and 15 KB/s each.

Only what a device shows is streamed: the tiles on the wall, or the one window at full size. A
phone in the background watches nothing.

## The owner's hand

Input goes through CDP (`Input.dispatchMouseEvent`, `insertText`, `dispatchKeyEvent`), the channel
agents use. Measured: a click lands in 10 ms and shows on the next picture 77 ms later; a click in
a cross-origin frame is `isTrusted` (the captcha case); "héllo ç € 日本" arrives as typed.

- Phone and tablet: a tap clicks where the finger lands, one finger scrolls the page, a pinch zooms
  the picture (the page stays a desktop page), two fingers move the zoomed picture. A text field
  under the picture types into the page with the phone's keyboard, autocorrect included (a
  correction is replayed as the backspaces and characters that make it). Keys a phone lacks (Tab,
  Esc, arrows) are buttons.
- Web: the mouse goes through as it is (press, move, release), so a drag selects and a hover opens
  a menu. The wheel scrolls; the keyboard types once the picture has the focus; paste sends text.
- Address bar, back, forward, reload, tabs to switch or close, close the window (twice when an
  agent is at work in it).

Positions travel as fractions of the picture the owner saw, and the sidecar maps them onto the
page's viewport, so the picture's size never matters.

An input is never queued. The app sends none while offline, and the server drops one older than
`INPUT_STALE_MS` (5 s): the native outbox replays what it held after a reconnect, and a tap
replayed on a page that has moved since clicks something else.

The VNC client stays the fallback for what the page cannot see: a system dialog, a site that would
refuse these clicks.

## The path

```
app ──WS──> channel (browser-live.ts) ──> BrowserSession.cast (cast.ts) ──WS──> sidecar (live.mjs) ──CDP──> Chromium
```

- `sidecar/live.mjs`: the stage, the tab each window shows, the screencasts, the inputs. Its
  WebSocket uses the `ws` bundled in Playwright (`utilsBundle`): no dependency added.
- `src/browser/cast.ts`: one socket to the sidecar, whatever the number of devices. Two devices
  watching one tab share one screencast, at the better of the two qualities they asked for. It
  reconnects with a backoff up to 10 s.
- `src/channels/my-claw-app/browser-live.ts`: per device, what it watches; the listing, read every
  `LIST_EVERY_MS` (1.5 s) while someone watches and sent only when it changed; the owner's inputs
  and controls. A device that has not drained `MAX_BUFFERED_BYTES` (2 MB) of pictures gets no new
  one until it has: a slow phone drops pictures, not the link.
- The listing never asks a page anything (`Target.getTargets`, `Browser.getWindowForTarget`): a
  frozen tab cannot hold it up (`docs/browser-windows.md`).

## Frames

Client:

- `browser.watch` `{ windows: boolean, streams: [{ pageId, quality: "tile" | "focus" }] }`: replaces
  the device's previous watch. `windows: false` and no stream stops everything. The server forgets
  a device's watch with its socket; the app sends it again on reconnect.
- `browser.input` `{ pageId, ts, input }`, `input` one of `tap`, `down`, `up`, `move` (`x`, `y` in
  0..1, `button`), `wheel` (`x`, `y`, `dx`, `dy` in page pixels), `text`, `key` (`key`,
  `modifiers`).
- `browser.control` `{ id, action, windowId?, pageId?, url? }`, `action` one of `stage`,
  `new_window`, `focus_tab`, `close_tab`, `close_window`, `back`, `forward`, `reload`, `goto`. An
  address without a scheme gets `https://`; `file://` is refused.

Server:

- `browser.windows.result` `{ windows: [{ alias, windowId, onStage, state, task?, tabs: [{ pageId,
  title, url, active }] }], error? }`, `state` one of `working`, `waiting` (a handoff), `free`.
- `browser.frame` `{ pageId, seq, data, width, height }`: a JPEG in base64, and the viewport it
  shows in CSS pixels. `seq` grows per tab; the app never replaces a picture with an older one.
- `browser.frame.gone` `{ pageId }`: the tab closed.
- `browser.control.result` `{ id?, ok, error? }`, also sent when an input fails.
