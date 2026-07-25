# Browser

## Architecture

The app runs under **Bun**, but Playwright's `connectOverCDP` **hangs under Bun**
(proven: works under Node, hangs under Bun even though the CDP HTTP/WebSocket endpoint
is healthy). So all Playwright lives in a separate **Node sidecar** process; the Bun app
drives it over loopback HTTP. Playwright `Page`/`Context` objects never cross the process
boundary — they are referenced by opaque string ids. Screenshots are written to `/tmp`
(shared FS) and only the path is returned.

```
User → Main Agent → Browser Subagent → BrowserClient ──HTTP──> Node sidecar → Playwright → Chromium (Xvfb :99)
        (Bun)                           (Bun)        :9223      (Node)                       :9222
                                                                                              ↓
                                                                                       noVNC :6080 (human view)
```

## Layers

| Layer | Files | Role |
|---|---|---|
| Sidecar | `sidecar/` (Node) | Owns Playwright. `browser.mjs`: CDP connection, session/page registries, dialog + download policy. `snapshot.mjs`: ref stamping, cross-frame resolution, label overlay. `handlers.mjs`: one function per operation. `server.mjs`: HTTP routing only |
| Client | `src/browser/client.ts` (Bun) | Thin HTTP client to the sidecar; one session per task, pages addressed by id, per-endpoint timeouts |
| Tools | `src/tools/browser/` | `state` (page pointer, URL guard), `navigation` (pages/tabs), `actions` (things done to the page), `lowlevel` (eval/CDP/dialog/download/pdf), `delegate` (`delegate_browser_task`, the only tool the main agent sees) |
| Subagent | `src/agent/subagents/browser.ts` | Loop + LLM-driven human-in-the-loop + attachment accumulation + shared prompt (CORE/SOUL/USER) |

## Tools

| Tool | Purpose |
|---|---|
| `browser_navigate(url)` | Open URL, return snapshot with refs |
| `browser_snapshot()` | Accessibility tree with `[__ref=N]` |
| `browser_click(ref)` | Click element by ref |
| `browser_type(ref, text)` | Fill field by ref |
| `browser_select_option(ref, value)` | Pick a value in a native `<select>` **or** a custom combobox (options have no clickable ref of their own) |
| `browser_upload_file(path, ref?)` | Upload a local file through the native OS dialog. `ref` optional: a file input is usually hidden, so it is located in the page |
| `browser_press_key(key, ref?)` | Enter/Tab/Escape/Arrow... — often the only way to drive a custom dropdown |
| `browser_scroll(direction?, amount?, ref?)` | Scroll the page or bring an element into view (needed for `(offscreen)` refs) |
| `browser_hover(ref)` | Hover — menus that open on hover, tooltips |
| `browser_drag(from_ref, to_ref)` | Drag and drop (sliders, reorderable lists, drop zones) |
| `browser_click_at(x, y)` | Click by position, as **fractions** of the viewport. Reaches anything with no ref: canvas, WebGL, maps |
| `browser_wait_for(text?, ref?, timeout_ms?)` | Wait for text/ref/delay instead of re-snapshotting in a loop |
| `browser_handle_dialog(accept, prompt_text?)` | Decide the answer to the NEXT native dialog (one-shot; auto-accept otherwise) |
| `browser_download(timeout_ms?)` | Save a downloaded file into the sandboxed download dir, return its path |
| `browser_pdf(path?)` | Save the page as a PDF (headful-safe: goes through CDP `Page.printToPDF`) |
| `browser_eval(js)` | **Gated** by `allowEval`. JS in the page, statement body with `return` |
| `browser_cdp(method, params)` | **Gated** by `allowCdp` + allowlist. Raw CDP on the current page |
| `browser_screenshot(labels?)` | Screenshot. `labels=true` overlays red ref tags |
| `browser_list_tabs()` | List open tabs |
| `browser_focus_tab(index)` | Switch to tab |
| `browser_close_tab(index)` | Close tab |
| `browser_done(summary, needs_human?)` | Finish task, or request human takeover |
| `delegate_browser_task(url, instructions)` | Main agent → subagent. Screenshots auto-attached to response |

This surface is being extended so the subagent can finish tasks that currently end in a human
handoff (uploads, custom comboboxes, elements without a ref). Spec, phases and security model:
**`docs/browser-autonomy.md`**.

## Human-in-the-Loop

**LLM-driven, no keyword scan.** The subagent decides itself when it is genuinely
blocked (real CAPTCHA / bot-check / 2FA-OTP it cannot solve) and calls
`browser_done(summary, needs_human=true)`. It does NOT stop at ordinary login/password
forms — it fills them in.

When `needs_human` is set, `delegate_browser_task` returns a message pointing the user to
the live browser (`config.browser.novncUrl`, default `http://localhost:6080`). The user
solves the blocker and replies "continue".

> Rationale (browser-use / BrowserAct / Skyvern): handoff is a structured signal decided by
> the agent, never a regex on page text. Keyword scanning false-positives on normal login
> pages.

## Guardrails

- **SSRF**: `browser_navigate` blocks `localhost`, `127.0.0.1`, `file://`
- **Dialog auto-dismiss**: `page.on('dialog', d => d.accept())` — no blocking alerts
- **Serialized tasks**: there is ONE shared Chromium, so `delegate_browser_task` calls are
  queued (`enqueueBrowserTask`) and run strictly one at a time. Parallel tasks used to
  clobber each other's tabs/refs and fail with "browser has been closed" / max-steps.
- **Per-subagent page state**: the "current page" pointer lives in a `BrowserPageState`
  owned by each subagent, not in a module global — concurrent runs cannot cross-click.
- **Render settle**: navigate waits `load` (bounded 8s) after `domcontentloaded`, and
  screenshots wait `networkidle` (bounded 3s) + 300ms — SPAs no longer produce blank shots.
- **Overlay hygiene**: the subagent prompt requires dismissing cookie/consent banners
  before acting or screenshotting.
- **Max-steps salvage**: when the step budget runs out, one final tool-free LLM call
  summarizes what was actually found instead of discarding 30 steps of browsing.
- **Persistent tabs**: tabs are **never auto-closed** — the shared browser stays open so the
  user can keep working on the same tabs across tasks. They close only on explicit
  `browser_close_tab`, when the user closes them, or on a browser restart.
- **Tab reuse**: `browser_navigate` reuses the current tab (no tab-per-action); the open-tabs
  list is injected into the subagent prompt so it focuses an existing relevant tab instead of
  opening duplicates. `new_tab=true` forces a separate tab.
- **Scope**: Subagent only gets browser tools (no bash/read/write). Inherits CORE_PROMPT + SOUL.md + USER.md (no AGENTS.md, no skills, no memory)
- **Cancellable**: the parent run's `AbortSignal` is threaded into the subagent loop (via the tool's
  `__signal`). `/stop` interrupts it — it bails out before the next LLM call or tool execution and
  returns "Stopped by user."
- **Bounded context**: snapshots are large, so the loop runs `trimToContextWindow` before each LLM
  call; a long (up to `maxSteps`) run cannot outgrow the model context window.
- **Ref coverage**: the stamping selector includes `role=option/listbox/menuitem*/treeitem/slider/
  spinbutton`, `label`, `summary` and `[tabindex]`, so custom (React) dropdown options are
  clickable instead of merely visible in the aria tree.
- **Viewport-first refs**: with a 400-ref cap, visible elements are numbered first and off-screen
  ones are flagged `(offscreen — scroll to reach)`, so page chrome can never crowd out the
  element the agent is working on.
- **No mechanical handoff**: the subagent prompt makes `needs_human` exclusive to human barriers
  (CAPTCHA, 2FA, payment, user decision) and requires walking an escalation ladder first:
  fresh ref -> `select_option` -> `upload_file` -> keyboard -> `wait_for` -> `scroll` -> `hover`
  -> labelled screenshot + `click_at`.
- **Cross-frame refs**: refs are stamped per frame with ONE global counter and resolved by
  searching every frame, so iframe content is both visible and actionable. Shadow roots are
  walked explicitly when stamping (Playwright's CSS already pierces them when acting).
- **Fractional coordinates**: `browser_click_at` takes fractions of the viewport, never pixels.
  Screenshots may be downscaled before reaching the model, which would silently shift pixel
  coordinates; fractions survive any resize. Each screenshot reports the viewport it used.
- **Gated low-level access**: `browser_eval` and `browser_cdp` are off by default and are not
  even registered (nor mentioned in the prompt) unless enabled — an advertised-but-disabled
  tool just burns a step. Every `eval`/`cdp` call is written to the audit log.
- **CDP denylist in the sidecar**: `Browser.*`, `Target.*`, `Storage.*`, `Security.*`, `Fetch.*`
  and the `Network` cookie/header methods are refused by the sidecar itself, so no config value
  can expose the session's credentials or let the subagent escape its own page.
- **Filesystem sandbox**: upload paths and `browser_pdf` destinations go through
  `resolveWorkspacePath` in Bun before the sidecar sees them; downloads land in
  `browser.downloadDir` (default `<workspace>/downloads`).
- **Per-endpoint timeouts**: one 90s global budget was either too short for slow operations or
  too long for a wedged fast one. Each endpoint has its own, set just above the sidecar's own
  limit so the server-side error wins and the agent gets a real message.

### Known limit

An element with no role, no `tabindex`, no `href` and only a JS-attached listener (a bare
`<div>` wired up in code) is not detectable as interactive and gets no ref. That is precisely
what `browser_click_at` exists for.

## Lifecycle (never kill the shared Chromium)

Both the sidecar (`my-claw-browser-sidecar.service`, Node) and Chromium
(`my-claw-chromium.service`) are **external systemd services** with `Restart=always`. my-claw
(Bun) is a stateless client to the sidecar and must never terminate Chromium.

- **One CDP connection**: the sidecar connects to Chromium once and reuses it across every
  task. It never calls `browser.close()` (with `connectOverCDP` that would kill the external
  Chromium); on `disconnected` it resets and reconnects on the next task.
- **Per-task session**: each task gets a sidecar session; `cleanup` only drops that session's
  bookkeeping — it **leaves all tabs open** so the browser persists for the next task.
  Screenshots are not deleted here (sent as attachments, then removed post-send by
  `cleanupGeneratedTempFiles`, which sweeps `/tmp/browser-*` and `/tmp/tts-*`).
- **Self-healing**: if Chromium or the sidecar restarts (e.g. `myclaw update`), the next task
  reconnects. A down sidecar fails fast (`ECONNREFUSED`).
- **Infra vs blocker**: sidecar/CDP unreachability (`sidecar unreachable`, `ECONNREFUSED`,
  websocket error, target closed) returns a technical failure (`needs_human=false`), NOT a
  noVNC handoff. See `isBrowserInfraError`. A real CAPTCHA/2FA is the only thing that triggers
  the human handoff.

## Config

```json
{
  "browser": {
    "enabled": true,
    "sidecarUrl": "http://127.0.0.1:9223",
    "novncUrl": "http://localhost:6080",
    "maxSteps": 60,
    "allowEval": false,
    "allowCdp": false,
    "cdpAllowlist": ["DOM.*", "Input.*", "Runtime.evaluate"],
    "downloadDir": "/home/user/.my-claw/workspace/downloads",
    "timeoutsMs": { "default": 30000, "navigate": 45000 }
  }
}
```

- `sidecarUrl` (default `http://127.0.0.1:9223`): where the Bun app reaches the Node sidecar.
- `maxSteps` (default 60): the ladder spends steps on purpose instead of handing off.
- `allowEval` / `allowCdp` (default false): register `browser_eval` / `browser_cdp`. The page
  content the subagent reads is untrusted, so these widen the prompt-injection surface — enable
  them deliberately. `browser_eval` implies access to non-`HttpOnly` cookies, which is why the
  real controls are the flags themselves plus the audit log, not a cookie API blocklist.
- `cdpAllowlist` (default `DOM.*`, `Input.*`, `Emulation.*`, `Runtime.evaluate`,
  `Page.navigate|captureScreenshot|printToPDF`): replaces the default list entirely when set.
  The sidecar denylist always wins on top of it.
- `downloadDir` (default `<workspace>/downloads`): keep it inside the workspace if the agent
  should be able to `read` what it downloaded.
- `timeoutsMs`: per sidecar endpoint (`navigate`, `upload`, `wait-for`, `download-wait`, ...)
  plus `default`, in milliseconds.
- All of it hot-reloads: `browser` is in `HOT_OBJECT_SECTIONS` and read live per run.
- The Chromium CDP endpoint is not a config knob: the **sidecar** reads it from the `CDP_URL`
  env in its systemd unit (default `http://127.0.0.1:9222`).

## Skill

`src/skills/web-browsing/SKILL.md` — teaches the main agent when to delegate to the browser subagent and how to handle human intervention.

## Remote Monitoring

- noVNC :6080 shows the live Chromium on Xvfb :99
- When subagent asks for help, user opens browser at :6080
- Subagent detects page change via next snapshot and continues

## Tests

- **Unit**: `tests/subagents/browser.test.ts`, `tests/tools/browser-tools.test.ts` (mock client),
  `tests/browser/client.test.ts` (HTTP client over mock fetch)
- **E2E**: `tests/e2e/browser-delegation.test.ts`; `tests-e2e/browser/basic.test.ts` spawns the
  real Node sidecar against a live Chromium (requires `BROWSER_E2E=1`, `NODE_BIN` optional).
  Its `/combobox`, `/upload` and `/tall` fixtures reproduce the two real-world blockers
  (portal-rendered `role=option` list, hidden file input behind a button) offline — no
  dependency on a third-party site.

## Key Files

```
sidecar/
  browser.mjs        # Node: CDP connection, session/page registries, dialog + download policy
  snapshot.mjs       # Ref stamping (frames + shadow DOM), cross-frame resolveRef, label overlay
  handlers.mjs       # One function per operation (the HTTP surface)
  server.mjs         # HTTP routing only
src/browser/
  client.ts          # Bun: HTTP client to the sidecar (pages = opaque ids), per-endpoint timeouts
  types.ts           # Snapshot, Attachment, TabInfo, Result, ActionInfo, viewport, low-level results
src/tools/browser/
  state.ts           # Page pointer, URL guard, snapshot formatting
  navigation.ts      # navigate/snapshot/screenshot + tabs
  actions.ts         # click, type, select_option, upload, key, scroll, hover, drag, click_at, wait_for
  lowlevel.ts        # eval, cdp (allowlist), dialog, download, pdf
  delegate.ts        # delegate_browser_task + the one-at-a-time queue
  index.ts           # Public surface
src/agent/subagents/browser.ts
  # Subagent loop + human handoff + attachment accumulation + shared prompt
packaging/templates/my-claw-browser-sidecar.service
  # systemd unit (Node, Restart=always, CDP_URL+PORT env)
src/skills/web-browsing/SKILL.md
  # When to delegate, intervention rules
docs/browser.md
  # This file
docs/browser-autonomy.md
  # Spec: root causes, tool surface, escalation ladder, security model, phases
```
