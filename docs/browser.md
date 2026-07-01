# Browser

## Architecture

The app runs under **Bun**, but Playwright's `connectOverCDP` **hangs under Bun**
(proven: works under Node, hangs under Bun even though the CDP HTTP/WebSocket endpoint
is healthy). So all Playwright lives in a separate **Node sidecar** process; the Bun app
drives it over loopback HTTP. Playwright `Page`/`Context` objects never cross the process
boundary — they are referenced by opaque string ids. Screenshots are written to `/tmp`
(shared FS) and only the path is returned. See `SIDECAR-BROWSER.md`.

```
User → Main Agent → Browser Subagent → BrowserClient ──HTTP──> Node sidecar → Playwright → Chromium (Xvfb :99)
        (Bun)                           (Bun)        :9223      (Node)                       :9222
                                                                                              ↓
                                                                                       noVNC :6080 (human view)
```

## Layers

| Layer | Files | Role |
|---|---|---|
| Sidecar | `sidecar/server.mjs` (Node) | Owns Playwright: connect, navigate, snapshot, click, type, screenshot, label overlay, session/page registry |
| Client | `src/browser/client.ts` (Bun) | Thin HTTP client to the sidecar; one session per task, pages addressed by id |
| Tools | `src/tools/browser.ts` | 9 tools (8 in main registry + `browser_done` in subagent) |
| Subagent | `src/agent/subagents/browser.ts` | Loop + LLM-driven human-in-the-loop + attachment accumulation + shared prompt (CORE/SOUL/USER) |

## Tools

| Tool | Purpose |
|---|---|
| `browser_navigate(url)` | Open URL, return snapshot with refs |
| `browser_snapshot()` | Accessibility tree with `[__ref=N]` |
| `browser_click(ref)` | Click element by ref |
| `browser_type(ref, text)` | Fill field by ref |
| `browser_screenshot(labels?)` | Screenshot. `labels=true` overlays red ref tags |
| `browser_list_tabs()` | List open tabs |
| `browser_focus_tab(index)` | Switch to tab |
| `browser_close_tab(index)` | Close tab |
| `browser_done(summary, needs_human?)` | Finish task, or request human takeover |
| `delegate_browser_task(url, instructions)` | Main agent → subagent. Screenshots auto-attached to response |

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
> pages. See `FIX-BROWSER-HANDOFF.md`.

## Guardrails

- **SSRF**: `browser_navigate` blocks `localhost`, `127.0.0.1`, `file://`
- **Dialog auto-dismiss**: `page.on('dialog', d => d.accept())` — no blocking alerts
- **Persistent tabs**: tabs are **never auto-closed** — the shared browser stays open so the
  user can keep working on the same tabs across tasks. They close only on explicit
  `browser_close_tab`, when the user closes them, or on a browser restart.
- **Tab reuse**: `browser_navigate` reuses the current tab (no tab-per-action); the open-tabs
  list is injected into the subagent prompt so it focuses an existing relevant tab instead of
  opening duplicates. `new_tab=true` forces a separate tab.
- **Scope**: Subagent only gets browser tools (no bash/read/write). Inherits CORE_PROMPT + SOUL.md + USER.md (no AGENTS.md, no skills, no memory)

## Lifecycle (never kill the shared Chromium)

Both the sidecar (`my-claw-browser-sidecar.service`, Node) and Chromium
(`my-claw-chromium.service`) are **external systemd services** with `Restart=always`. my-claw
(Bun) is a stateless client to the sidecar and must never terminate Chromium.

- **One CDP connection**: the sidecar connects to Chromium once and reuses it across every
  task. It never calls `browser.close()` (with `connectOverCDP` that would kill the external
  Chromium); on `disconnected` it resets and reconnects on the next task.
- **Per-task session**: each task gets a sidecar session; `cleanup` only drops that session's
  bookkeeping — it **leaves all tabs open** so the browser persists for the next task.
  Screenshots are not deleted here (sent as attachments, removed post-send by the adapter).
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
    "cdpUrl": "http://127.0.0.1:9222",
    "sidecarUrl": "http://127.0.0.1:9223",
    "novncUrl": "http://localhost:6080",
    "maxSteps": 30
  }
}
```

- `sidecarUrl` (default `http://127.0.0.1:9223`): where the Bun app reaches the Node sidecar.
- `cdpUrl` (default `http://127.0.0.1:9222`): used by the **sidecar** (via `CDP_URL` env in its
  systemd unit) to reach Chromium.

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
  real Node sidecar against a live Chromium (requires `BROWSER_E2E=1`, `NODE_BIN` optional)

## Key Files

```
sidecar/server.mjs   # Node: Playwright over CDP, session/page registry, HTTP API
src/browser/
  client.ts          # Bun: HTTP client to the sidecar (pages = opaque ids)
  types.ts           # Snapshot, Attachment, TabInfo, Result
src/tools/browser.ts
  # 8 tool factories + SSRF guard + delegate_browser_task
src/agent/subagents/browser.ts
  # Subagent loop + human handoff + attachment accumulation + shared prompt
packaging/templates/my-claw-browser-sidecar.service
  # systemd unit (Node, Restart=always, CDP_URL+PORT env)
src/skills/web-browsing/SKILL.md
  # When to delegate, intervention rules
docs/browser.md
  # This file
```
