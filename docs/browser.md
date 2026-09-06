# Browser

## Architecture

The app runs under **Bun**, but Playwright's `connectOverCDP` **hangs under Bun**
(proven: works under Node, hangs under Bun even though the CDP HTTP/WebSocket endpoint
is healthy). So all Playwright lives in a separate **Node sidecar** process; the Bun app
drives it over loopback HTTP. Playwright `Page`/`Context` objects never cross the process
boundary — they are referenced by opaque string ids. Screenshots are written to `/tmp`
(shared FS) and only the path is returned.

```
User → Main Agent → delegate_browser_task → SubAgentRunner → browser agent (AgentBridge) → BrowserClient ──HTTP──> Node sidecar → Playwright → Chromium (Xvfb :99)
        (Bun)                                                  session subagent/run-<uuid>         (Bun)        :9223      (Node)                       :9222
                                                                                                                                                          ↓
                                                                                                                                                   noVNC :6080 (human view)
```

## The browser is a sub-agent

Since 0.7 a browsing task is a run of the `browser` agent through the same runner and loop as
`spawn`: a private one-shot session of the caller (`subagent/run-<uuid>`, type `browser`), announced
with the delegate's own tool call id so the card in the parent thread is a door, streamed to its own
thread (tokens, tool cards, reasoning), steerable mid-run, and kept: the owner opens it, reads what
the agent did, messages it to carry on in the same browser, kills or resets it from the roster.
Compaction, the iteration budget and the summary forced at the end of it are the bridge's.

Before that it was a private loop (`src/agent/subagents/browser.ts`, 490 lines) with its own tool
registry, its own messages array and no session: nothing to open, nothing to replay, no streaming,
no steering. `docs/file-agents.md` had deferred folding it into the runner ("a separate decision");
the owner took it when the card's UX fell short of every other sub-agent's.

What the door (`src/tools/browser/delegate.ts`) still does around the run:

- frames the task: `Task: … / Start URL: … / ## Open browser tabs …`, the tab list read from the
  sidecar so the reuse rule has something to work with;
- runs the agent as `spawn` would (`SubAgentRunner.spawn`, mode `run`, visibility `private`);
- reads back what the run recorded for it (`src/tools/browser/session.ts`): `browser_done` records
  the summary and `needs_human`; a tool whose failure has an infrastructure signature records it and
  tells the model to stop. A run with no recorded `browser_done` is reported as a failure carrying
  its last words, never as a completed task;
- returns the screenshots the run's tools produced as the tool result's attachments, so they reach
  the person through the caller's reply as they always did (`SubAgentRunner.spawn` now returns them
  for every sub-agent, and `spawn` passes them on too).

What the runner does for a `browser`-typed run, whoever started it (the door or a `send`): it takes
the browser queue (`enqueueBrowserTask`, one Chromium, one run at a time) and calls
`BrowserSession.cleanup()` when the run ends, so the pages it opened are closed and the next run
starts on a fresh sidecar session.

`spawn` still does not offer `browser` (`AgentRegistry.list`): a spawn of it would skip the framing,
the queue and the handoff. The delegate is the door; `list_agents`, `/agents`, the roster and the
app see the runs it creates like any other one-shot.

## Layers

| Layer | Files | Role |
|---|---|---|
| Sidecar | `sidecar/` (Node) | Owns Playwright. `browser.mjs`: CDP connection, session/page registries, dialog + download policy. `snapshot.mjs`: ref stamping, cross-frame resolution, label overlay. `handlers.mjs`: one function per operation. `server.mjs`: HTTP routing only |
| Client | `src/browser/client.ts` (Bun) | Thin HTTP client to the sidecar; one sidecar session per run, pages addressed by id, per-endpoint timeouts; `reconfigure()` between runs follows the live config |
| Tools | `src/tools/browser/` | `state` (page pointer, URL guard, the run's workspace), `navigation` (pages/tabs), `inspect` (find/network/response), `actions` (things done to the page), `lowlevel` (eval/CDP/dialog/download/pdf), `session` (the one browser, the queue, the outcome, `browser_done`), `register` (the toolbox into the registry), `delegate` (`delegate_browser_task`, the door every other agent sees) |
| Agent | `src/agents/builtin/browser.md` | The browser agent: `base: browser`, prompt and rules, `maxIterations: 60`. Runs through `src/subagents/runner.ts` and `src/agent/bridge.ts` like every sub-agent |

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
| `browser_done(summary, needs_human?)` | Record the outcome for the caller (summary, human takeover), then the agent answers with the summary |
| `delegate_browser_task(url, instructions)` | Any other agent → a run of the browser agent. Screenshots auto-attached to response |

**Scoping.** The `browser_*` tools are the `browser` tool base (`ToolRegistry.getForAgent("browser")`,
a closed set: no MCP, no plugin, no skills) and every other base (`main`, `general`, `research`,
`cron`) is filtered of them: two drivers on one Chromium is the failure the queue exists to prevent.
`browser_eval` and `browser_cdp` are registered always and taken away per run through
`ResolvedAgent.deny` when `browser.allowEval` / `browser.allowCdp` are off, so a hot-reload toggles
them without a restart and a disabled tool is never advertised. Only the agent named `browser` may
declare `base: browser` in its file; another file claiming it falls back to `general` with a warning.
The tools read the calling run's workspace from `__workspaceDir` (uploads, downloads, PDFs), since
one registration serves every conversation.

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

- **Renderer sandbox on**: the unit runs Chromium **without** `--no-sandbox`. That flag had been
  there since the first draft, and it disables the one boundary between a page the agent was told
  to open and this host -- on a browser that follows links chosen by whatever it is reading. It was
  a habit, not a requirement: unprivileged user namespaces are enabled here, and the exact service
  command line was run without the flag to check (CDP answered, no sandbox error). If a host ever
  does refuse it (userns restricted by AppArmor), the answer is a setuid `chrome-sandbox`, not the
  flag back.
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
- **Model**: `config.agents.browser.llm.defaultModel`, the global default under it, and only then
  the first OpenAI-compatible model in the catalogue. The loop speaks chat-completions and cannot
  run a claude-sdk or codex default, which is why it used to skip agent resolution altogether and
  take that last fallback whatever `agents.browser` said -- so the model was decided by the order
  of `llm.models`, and a gateway that blocks the first entry broke every browser task.
- **Cancellable**: the parent run's `AbortSignal` is threaded into the sub-agent run (via the tool's
  `__signal`, then the runner's tracked signal). `/stop` and the app's Stop interrupt it like any
  sub-agent run; the browser run's own thread has a Stop of its own too.
- **Bounded context**: snapshots are large; the bridge trims to the context window before each LLM
  call and compacts like every run, so a long (up to `maxSteps`) run cannot outgrow the model
  context window.
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
- `maxSteps` (default 60): the budget of one browsing task, the `browser` agent's `maxIterations`
  (an explicit `agents.browser.maxIterations` wins over it). The ladder spends steps on purpose
  instead of handing off.
- `allowEval` / `allowCdp` (default false): offer `browser_eval` / `browser_cdp` to the run. The page
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
- When subagent asks for help, user opens browser at :6080 — or with any VNC client at the
  same host, port 5900 (handy on phones; the agent's paused message gives both).
- Subagent detects page change via next snapshot and continues
- The chain is `websockify :6080 -> x11vnc :5900 -> Xvfb :99`, so both hops are pinned:
  `my-claw-vnc` passes `-rfbport 5900` (x11vnc otherwise drifts to 5901+ when the port is
  taken, leaving noVNC proxying nothing) and both units kill a stale x11vnc/websockify in
  `ExecStartPre`. A second Chromium on the same `:99` is the failure to look for: the last
  window mapped wins, so a human takeover can land on a browser the sidecar does not drive
  (the sidecar's own instance is the one answering `CDP_URL`, i.e. `127.0.0.1:9222`).

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
  inspect.ts         # find, network, response
  lowlevel.ts        # eval, cdp (allowlist), dialog, download, pdf
  session.ts         # the one browser (client + page pointer), the one-at-a-time queue, the run's outcome, browser_done
  register.ts        # the toolbox into the process registry (browser base)
  delegate.ts        # delegate_browser_task: frames the task, runs the browser agent as a sub-agent, reads the outcome back
  index.ts           # Public surface
src/agents/builtin/browser.md
  # The browser agent: base, prompt, rules, budget. Runs through src/subagents/runner.ts + src/agent/bridge.ts
packaging/templates/my-claw-browser-sidecar.service
  # systemd unit (Node, Restart=always, CDP_URL+PORT env)
src/skills/web-browsing/SKILL.md
  # When to delegate, intervention rules
docs/browser.md
  # This file
docs/browser-autonomy.md
  # Spec: root causes, tool surface, escalation ladder, security model, phases
```
