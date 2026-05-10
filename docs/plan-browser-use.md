# Plan: Browser Use for my-claw

## Constraints
- You ALREADY run Chromium headful on Xvfb :99 with CDP :9222 and noVNC :6080
- No new browser launch. Just connect to the existing one.
- Single-tenant. No sandbox, no cloud provider needed.
- Must be subagent-based for isolation and clean context.
- Remote monitoring works via existing noVNC :6080.

## Architecture (3 layers)

### 1. CDP Client (`src/browser/`)
- `cdp.ts` — HTTP client to `http://127.0.0.1:9222/json/*` and WebSocket to `ws://127.0.0.1:9222/devtools/page/<id>`
- `snapshot.ts` — `Accessibility.getFullAXTree` → compact text tree with numeric refs
- `actions.ts` — `Page.navigate`, `Input.dispatchMouseEvent`, `Input.dispatchKeyEvent`, `Page.captureScreenshot`
- `tabs.ts` — list/create/close tabs via CDP `Target` domain

### 2. Browser Tools (`src/tools/browser.ts`)
5 tools, all hit the same CDP-backed browser service:
- `browser_navigate(url)` — opens URL in current tab, returns snapshot
- `browser_snapshot()` — returns accessibility tree with `[ref=N]` labels
- `browser_click(ref)` — resolves ref to nodeId, dispatches click
- `browser_type(ref, text)` — focuses node, types text
- `browser_screenshot(full?)` — captures PNG, returns as `Attachment` (vision model or user view)

No scroll/press/back tools initially. Add if needed.

### 3. Browser Subagent (`src/agent/subagents/browser.ts`)
Dedicated subagent for multi-step web tasks.
- Prompt: "You are a web browsing assistant. Use browser tools to complete the task. After each action, snapshot to verify. If you see a CAPTCHA, login wall, or 2FA, ask the user for help via the chat channel."
- Tool access: `browser_*` tools only (no bash/read/write to avoid side effects)
- Lifecycle: main agent spawns browser subagent with task + URL. Subagent runs the loop. Returns summary + any downloaded data.
- When captcha detected: subagent returns early with `needs_human: true` and the main agent asks the user to open noVNC and solve it.

## Integration Flow

```
User: "book me a train ticket to Lyon"
Main agent → delegates to browser subagent
task: "find next train Paris-Lyon, select 9am, fill passenger info"

Browser subagent loop:
1. browser_navigate("https://www.sncf-connect.com")
2. browser_snapshot() → sees search form refs
3. browser_click(ref=12) → departure field
4. browser_type(ref=12, "Paris")
5. ... (loop)
6. On captcha → return { success: false, needs_human: true, hint: "CAPTCHA on payment page" }

Main agent → sends to user:
"J'ai besoin de ton aide pour le CAPTCHA. Va sur http://kssimi.fr:6080 (noVNC), 
résous le captcha, puis dis-moi 'continue' et je reprends."

User solves captcha, says "continue"
Main agent → respawns browser subagent with same task + current URL
Subagent → finishes booking
```

## Remote Monitoring (already works)
- noVNC on :6080 shows the live Chromium on :99
- When subagent asks for help, user opens browser at :6080, solves captcha/2FA
- Subagent detects page change via next snapshot and continues

## Why Not Hermes/OpenClaw Directly?
- Hermes uses heavy `agent-browser` Node CLI + Playwright. Overkill for single-tenant.
- OpenClaw uses Playwright + control service + plugin system. Too complex for my-claw's minimal architecture.
- Both spawn their own browser. You already have one running.
- CDP direct is ~300 LOC vs 3000 LOC. Fits my-claw's philosophy.

## Files to Create

```
src/browser/
  cdp.ts          # HTTP + WS CDP client
  snapshot.ts     # AX tree parser
  actions.ts      # click, type, navigate, screenshot
  service.ts      # tab management, session state
  types.ts        # CDP message types

src/tools/browser.ts
  # 5 tool factories using BrowserService

src/agent/subagents/browser.ts
  # SubAgentRunner specialization for browser tasks

src/agent/prompt/browser.md
  # Subagent system prompt (browsing loop, captcha rules)

skills/web-browsing/
  SKILL.md        # Guide for main agent: when to delegate to browser subagent
```

## Config
```json
{
  "browser": {
    "cdpUrl": "http://127.0.0.1:9222",
    "headless": false,
    "viewport": "1920x1080"
  }
}
```
Default `cdpUrl` auto-discovers from `chromium-cdp.service` (:9222).

## Open Questions
1. Do we attach to an existing tab or create a new tab per subagent task?
   → **New tab per task.** Clean isolation. Close on completion.
2. Screenshot as vision input or attachment?
   → **Both.** Subagent can send screenshot to vision model for analysis. Also sent to user as attachment when asking for help.
3. Do we need a persistent CDP WebSocket or HTTP per action?
   → **HTTP per action for simplicity.** CDP HTTP endpoints work for most actions. WebSocket only if we need event streaming (console, network). Skip for v1.
4. How to detect "human needed"?
   → **Heuristic:** snapshot contains words "captcha", "verify", "login", "2fa", "code" + subagent failed after 3 retries. Then ask user.

## Milestones
1. CDP client + navigate + snapshot (1 day)
2. click + type + screenshot (1 day)
3. Browser tools registration + subagent wiring (1 day)
4. Skill + tests + docs (1 day)

Total: ~4 days of focused work.
