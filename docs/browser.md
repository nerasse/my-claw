# Browser

## Architecture

Playwright `connectOverCDP("ws://127.0.0.1:9222")` attaches to the existing Chromium on Xvfb :99. No new browser.

```
User → Main Agent → Browser Subagent → Playwright → Chromium (Xvfb :99)
                                         ↓
                                  noVNC :6080 (human view)
```

## 3 Layers

| Layer | Files | Role |
|---|---|---|
| CDP Client | `src/browser/pool.ts`, `service.ts`, `labels.ts` | Connect, navigate, snapshot, click, type, screenshot |
| Tools | `src/tools/browser.ts` | 9 tools (8 in main registry + `browser_done` in subagent) |
| Subagent | `src/agent/subagents/browser.ts` | Loop + captcha detection + human-in-the-loop + attachment accumulation + shared prompt (CORE/SOUL/USER) |

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
| `delegate_browser_task(url, instructions)` | Main agent → subagent. Screenshots auto-attached to response |

## Human-in-the-Loop

Subagent detects `captcha`/`login`/`2FA` → returns `{ needs_human: true }`.
Main agent asks user to open noVNC :6080, solve blocker, reply "continue".

## Guardrails

- **SSRF**: `browser_navigate` blocks `localhost`, `127.0.0.1`, `file://`
- **Dialog auto-dismiss**: `page.on('dialog', d => d.accept())` — no blocking alerts
- **Idle cleanup**: Pages inactive >5min auto-closed (sweep every 60s)
- **Tab isolation**: New tab per subagent task, cleaned on finish
- **Scope**: Subagent only gets browser tools (no bash/read/write). Inherits CORE_PROMPT + SOUL.md + USER.md (no AGENTS.md, no skills, no memory)

## Config

```json
{
  "browser": {
    "enabled": true,
    "cdpUrl": "http://127.0.0.1:9222",
    "maxSteps": 30,
    "idleTimeoutMs": 300000
  }
}
```

Default `cdpUrl` = `http://127.0.0.1:9222` (reads from running `chromium-cdp.service`).

## Skill

`src/skills/web-browsing/SKILL.md` — teaches the main agent when to delegate to the browser subagent and how to handle human intervention.

## Remote Monitoring

- noVNC :6080 shows the live Chromium on Xvfb :99
- When subagent asks for help, user opens browser at :6080
- Subagent detects page change via next snapshot and continues

## Tests

- **Unit**: 20 tests in `tests/subagents/browser.test.ts`, 10 in `tests/tools/browser-tools.test.ts`, 4 in `tests/browser/pool.test.ts`, 9 in `tests/browser/service.test.ts`
- **E2E**: 8 in `tests/e2e/browser-delegation.test.ts`, 5 in `tests-e2e/browser/basic.test.ts` (requires `BROWSER_E2E=1`)

## Key Files

```
src/browser/
  pool.ts          # CDP connect + idle sweeper
  service.ts       # navigate, click, type, screenshot, tabs
  labels.ts        # DOM ref overlay injection
  types.ts         # Snapshot, Attachment, TabInfo
src/tools/browser.ts
  # 8 tool factories + SSRF guard
src/agent/subagents/browser.ts
  # Subagent loop + human blocker + attachment accumulation + shared prompt
src/skills/web-browsing/SKILL.md
  # When to delegate, intervention rules
docs/browser.md
  # This file
```
