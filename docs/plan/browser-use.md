# Browser Use Integration Plan

## Overview

Add autonomous web browsing to my-claw via **Playwright connectOverCDP** attaching to the existing Chromium instance on Xvfb :99 (CDP :9222). The agent delegates complex multi-step web tasks to a dedicated **browser subagent** that loops: navigate → snapshot → act → verify. When blocked by CAPTCHA/login/2FA, the subagent surfaces the issue and the main agent asks the user to intervene via the existing noVNC :6080 remote viewer.

## Why Playwright CDP over raw CDP

| Feature | Raw CDP HTTP | Playwright connectOverCDP |
|---|---|---|
| `ariaSnapshot()` (LLM-optimized tree) | ❌ Verbose AXTree | ✅ Compact semantic refs |
| Screenshot labels overlay | ❌ Manual DOM injection | ✅ Built-in `data-testid` style |
| Dialog handling (alert/confirm/prompt) | ❌ Blocks subagent | ✅ Auto-dismiss or capture |
| Cross-origin iframe (OOPIF) | ❌ Complicated | ✅ Native frame tree |
| Multi-tab lifecycle | ❌ Manual Target domain | ✅ `context.pages()` |
| Screenshots after each action | ❌ Explicit call every time | ✅ One-liner `page.screenshot()` |
| Code size | ~300 LOC | ~500 LOC (still tiny) |

**Trade-off:** Adds `playwright-core` dependency (~30MB). Acceptable for the capability gain.

## Architecture

```
User Request
    ↓
Main Agent (LLM)
    ↓
Skill "web-browsing" loaded → read_skill("web-browsing")
    ↓
Main Agent delegates to Browser Subagent
    ↓
Browser Subagent (isolated context, browser tools only)
    │
    ├── browser_navigate("https://example.com")
    ├── browser_snapshot() → sees [ref=5] fields
    ├── browser_click(ref=5)
    ├── browser_type(ref=3, "hello")
    ├── browser_screenshot() → Attachment sent to user if stuck
    │
    On captcha detected:
    └── return { needs_human: true, hint: "CAPTCHA on checkout" }
        ↓
    Main Agent sends help request to user via Telegram/Matrix
    User opens noVNC :6080, solves captcha, replies "continue"
    Main Agent respawns Browser Subagent from same URL
    Subagent finishes task
```

## Infrastructure (already running)

| Service | Port | Role | Action |
|---|---|---|---|
| `chromium-cdp` | :9222 | Chromium headful on Xvfb | **Keep** — Playwright attaches here |
| `xvfb` | :99 | Virtual framebuffer | **Keep** — Chromium needs a display |
| `x11vnc` | :5900 | VNC server on :99 | **Keep** — noVNC backend |
| `noVNC` | :6080 | Web VNC viewer | **Keep** — Human monitoring/intervention |
| `faster-whisper` | :18792 | Local STT | **Keep** — my-claw voice |
| `bw-serve` | :8087 | Vaultwarden REST | **Keep** — Credentials skill |
| `openclaw-post-start` | — | Old oneshot | **Disable** (optional cleanup) |
| `matrix-autojoin` | — | Broken (placeholder token) | **Disable** (optional cleanup) |

**Playwright does NOT launch a new browser.** It connects to your existing Chromium via CDP WebSocket (`ws://127.0.0.1:9222`).

## New Files

### Core Browser Layer

```
src/browser/
  types.ts          # Playwright Page, CDP session types
  pool.ts           # Playwright browser pool (connect/reuse/disconnect)
  snapshot.ts       # ariaSnapshot() wrapper + ref extractor
  actions.ts        # navigate, click, type, screenshot, scroll, back
  dialogs.ts        # alert/confirm/prompt handler
  tabs.ts           # new tab, close tab, list tabs
  service.ts        # BrowserService orchestrator (stateful session)
```

### Tools

```
src/tools/browser.ts
  # Tool factories: createBrowserNavigateTool, createBrowserSnapshotTool,
  # createBrowserClickTool, createBrowserTypeTool, createBrowserScreenshotTool
```

### Subagent

```
src/agent/subagents/
  browser.ts        # BrowserSubagent class: prompt builder, loop runner, captcha detection
```

### Prompts & Skills

```
docs/prompt/browser-subagent.md   # System prompt for the browser subagent
skills/web-browsing/
  SKILL.md                          # When to delegate, loop rules, captcha policy
```

## Components Specification

### 1. Browser Pool (`src/browser/pool.ts`)

```typescript
class BrowserPool {
  private browser: Browser | null = null;
  private cdpUrl: string;

  async connect(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    this.browser = await chromium.connectOverCDP(this.cdpUrl);
    return this.browser;
  }

  async disconnect(): Promise<void> {
    await this.browser?.close();
    this.browser = null;
  }

  async newContext(viewport?: ViewportSize): Promise<BrowserContext> {
    const browser = await this.connect();
    return browser.newContext({ viewport });
  }
}
```

**Tests:**
- Unit: mock `connectOverCDP`, verify connect/disconnect lifecycle
- Unit: verify reuse when already connected
- Unit: verify auto-reconnect when connection drops

### 2. Browser Service (`src/browser/service.ts`)

```typescript
class BrowserService {
  constructor(private pool: BrowserPool) {}

  async navigate(url: string, tabLabel?: string): Promise<BrowserResult> {
    const context = await this.pool.newContext();
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "networkidle" });
    const snapshot = await this.snapshot(page);
    return { page, snapshot, url };
  }

  async snapshot(page: Page): Promise<BrowserSnapshot> {
    const aria = await page.locator("body").ariaSnapshot({ ref: true });
    return { raw: aria, refs: extractRefs(aria) };
  }

  async click(page: Page, ref: number): Promise<void> {
    await page.locator(`[__ref="${ref}"]`).click();
  }

  async type(page: Page, ref: number, text: string): Promise<void> {
    await page.locator(`[__ref="${ref}"]`).fill(text);
  }

  async screenshot(page: Page, fullPage?: boolean): Promise<Attachment> {
    const path = `/tmp/browser-${Date.now()}.png`;
    await page.screenshot({ path, fullPage });
    return { type: "image", path, mimeType: "image/png" };
  }
}
```

**Tests:**
- Unit: mock Playwright `Page`, verify `navigate` calls `goto` + `ariaSnapshot`
- Unit: verify `click` resolves ref to correct locator
- Unit: verify `screenshot` returns Attachment with valid path
- Unit: verify `snapshot` extracts ref numbers from aria text
- E2E (optional, behind flag): connect to real CDP :9222, navigate to `data:text/html,<button>OK</button>`, click, assert URL change

### 3. Browser Tools (`src/tools/browser.ts`)

Five tools registered in `ToolRegistry`:

```typescript
// All tools receive BrowserService via closure

const browserNavigateTool = {
  name: "browser_navigate",
  description: "Open a URL in a new browser tab. Returns a snapshot of the page with interactive element refs.",
  parameters: {
    url: { type: "string", description: "URL to open" },
    label: { type: "string", description: "Optional tab label for later reference" }
  },
  execute: async ({ url, label }) => {
    const result = await browserService.navigate(url, label);
    return {
      success: true,
      output: formatSnapshot(result.snapshot),
      attachments: [] // no attachments on navigate
    };
  }
};

const browserSnapshotTool = {
  name: "browser_snapshot",
  description: "Capture the current page accessibility tree. Use after every action to verify state.",
  parameters: {},
  execute: async () => {
    const snapshot = await browserService.snapshot(currentPage);
    return { success: true, output: formatSnapshot(snapshot) };
  }
};

const browserClickTool = {
  name: "browser_click",
  description: "Click an interactive element by its ref number (e.g., 5).",
  parameters: {
    ref: { type: "number", description: "Element ref number from snapshot" }
  },
  execute: async ({ ref }) => {
    await browserService.click(currentPage, ref);
    const snapshot = await browserService.snapshot(currentPage);
    return { success: true, output: formatSnapshot(snapshot) };
  }
};

const browserTypeTool = {
  name: "browser_type",
  description: "Type text into a form field by its ref number.",
  parameters: {
    ref: { type: "number" },
    text: { type: "string" }
  },
  execute: async ({ ref, text }) => {
    await browserService.type(currentPage, ref, text);
    const snapshot = await browserService.snapshot(currentPage);
    return { success: true, output: formatSnapshot(snapshot) };
  }
};

const browserScreenshotTool = {
  name: "browser_screenshot",
  description: "Capture a screenshot. Use when stuck or when the user asks to see the page.",
  parameters: {
    full_page: { type: "boolean", description: "Capture full page vs viewport only" }
  },
  execute: async ({ full_page }) => {
    const attachment = await browserService.screenshot(currentPage, full_page);
    return {
      success: true,
      output: `Screenshot saved.`,
      attachments: [attachment]
    };
  }
};
```

**Tests:**
- Unit: mock BrowserService, verify each tool calls the right method
- Unit: verify snapshot output formatting (refs extraction)
- Unit: verify screenshot tool returns Attachment in result
- Unit: verify navigate tool rejects invalid URLs (SSRF guard)

### 4. Browser Subagent (`src/agent/subagents/browser.ts`)

```typescript
class BrowserSubagent {
  constructor(
    private config: MyClawConfig,
    private toolRegistry: ToolRegistry,
    private llmProvider: LLMProvider
  ) {}

  async run(task: string, startUrl?: string): Promise<BrowserSubagentResult> {
    const prompt = buildBrowserPrompt(task, startUrl);
    const runner = new SubAgentRunner(this.config, this.toolRegistry);
    
    // Loop with safety limits
    for (let step = 0; step < MAX_STEPS; step++) {
      const response = await runner.run(prompt);
      
      if (response.tool_calls?.some(t => t.name === "browser_screenshot")) {
        // Screenshot requested — maybe stuck or asking for help
      }
      
      if (detectHumanBlocker(response.text)) {
        return {
          success: false,
          needs_human: true,
          hint: extractBlockerHint(response.text),
          current_url: await browserService.getCurrentUrl(),
          attachments: response.attachments || []
        };
      }
      
      if (response.done || step >= MAX_STEPS - 1) {
        return { success: true, summary: response.text };
      }
      
      prompt += `\nStep ${step + 1} result: ${response.text}\nContinue.`;
    }
  }
}
```

**Human blocker detection heuristics:**
- Snapshot text contains: `captcha`, `recaptcha`, `verify`, `human verification`, `i'm not a robot`
- Snapshot text contains: `login`, `sign in`, `password`, `2fa`, `two-factor`, `authentication code`
- After 3 consecutive failed actions (snapshot unchanged or error)

**Tests:**
- Unit: mock SubAgentRunner, verify loop runs up to MAX_STEPS
- Unit: verify captcha detection triggers `needs_human: true`
- Unit: verify login-wall detection triggers `needs_human: true`
- Unit: verify successful completion returns summary
- Unit: verify attachments from screenshot are forwarded in result

### 5. Integration in AgentBridge (`src/agent/bridge.ts`)

When the main agent's skill list includes `web-browsing`, the prompt builder adds:

```markdown
## Web Browsing
If the user asks you to interact with a website (search, book, fill forms, check status), delegate the task to the browser subagent using `delegate_browser_task(url, instructions)`.
The browser subagent will handle navigation, form filling, and screenshots.
If it reports `needs_human: true`, ask the user to open noVNC at http://<host>:6080, solve the blocker, and reply "continue".
```

Add `delegate_browser_task` tool to main agent registry:

```typescript
const delegateBrowserTool = {
  name: "delegate_browser_task",
  description: "Delegate a web browsing task to a specialized subagent.",
  parameters: {
    url: { type: "string" },
    instructions: { type: "string" }
  },
  execute: async ({ url, instructions }) => {
    const subagent = new BrowserSubagent(config, browserToolRegistry, llm);
    const result = await subagent.run(instructions, url);
    
    if (result.needs_human) {
      return {
        success: false,
        output: `Browser subagent needs human help: ${result.hint}\nOpen noVNC at http://your-host:6080 to see the browser.`,
        attachments: result.attachments
      };
    }
    
    return {
      success: true,
      output: result.summary,
      attachments: result.attachments || []
    };
  }
};
```

**Tests:**
- Unit: mock BrowserSubagent, verify delegation tool forwards result correctly
- Unit: verify `needs_human` response includes noVNC hint and attachments
- Unit: verify successful delegation returns summary

## Test Strategy

### Unit Tests (fast, mocked, ~90% coverage target)

```
tests/browser/
  pool.test.ts           # Connect, reuse, disconnect, reconnect
  service.test.ts        # navigate, click, type, snapshot, screenshot
  snapshot.test.ts        # Ref extraction, formatting
  dialogs.test.ts         # Alert/confirm/prompt auto-dismiss

tests/tools/
  browser-tools.test.ts  # All 5 tools, parameter validation, SSRF guard

tests/subagents/
  browser.test.ts        # Loop, captcha detection, login detection, max steps
```

**Mocking strategy:**
- Mock Playwright classes (`Browser`, `Page`, `Locator`) using `vi.fn()` (or Bun's `mock`)
- Mock `BrowserPool` for tool tests
- Mock `SubAgentRunner` for browser subagent tests
- Mock `LLMProvider` for end-to-end subagent flow tests

### E2E Tests (real browser, optional flag)

```
tests-e2e/browser/
  basic.test.ts          # Navigate to localhost test server, click button
  form.test.ts           # Fill form, submit, verify navigation
  captcha.test.ts        # Navigate to fake captcha page, verify detection
```

**Requirements for E2E:**
- Real Chromium running on Xvfb with CDP :9222
- Local test HTTP server (Bun `Bun.serve`) serving simple HTML pages
- Run behind `BROWSER_E2E=1` env flag to skip in CI

### Test Fixtures

```typescript
// tests/fixtures/browser-pages.ts
export const buttonPage = `
<!DOCTYPE html>
<html>
<body>
  <button id="btn" __ref="1">Click me</button>
  <div id="result"></div>
  <script>
    document.getElementById('btn').onclick = () => {
      document.getElementById('result').innerText = 'clicked';
    };
  </script>
</body>
</html>
`;

export const formPage = `
<!DOCTYPE html>
<html>
<body>
  <input __ref="1" id="name" placeholder="Name" />
  <button __ref="2" id="submit">Submit</button>
  <div id="output"></div>
  <script>
    document.getElementById('submit').onclick = () => {
      const val = document.getElementById('name').value;
      document.getElementById('output').innerText = 'Hello ' + val;
    };
  </script>
</body>
</html>
`;

export const captchaPage = `
<!DOCTYPE html>
<html>
<body>
  <div>Please verify you are human</div>
  <div class="g-recaptcha"></div>
</body>
</html>
`;
```

## Configuration

```typescript
// src/core/config.ts
export interface BrowserConfig {
  enabled?: boolean;
  cdpUrl?: string;           // Default: "http://127.0.0.1:9222"
  headless?: boolean;        // Always false for us (existing headful setup)
  viewport?: { width: number; height: number };
  maxSteps?: number;         // Default: 30
  idleTimeoutMs?: number;    // Default: 300000 (5min)
}
```

Default `cdpUrl` auto-detects from running `chromium-cdp.service` (reads from `/tmp` or probes :9222).

## Skill: web-browsing

```markdown
---
name: web-browsing
description: Delegate web browsing tasks to a specialized subagent. Use for filling forms, searching websites, checking accounts, booking, or any multi-step web interaction.
---

## When to use

Call `delegate_browser_task(url, instructions)` when:
- The user asks to search/retrieve info from a specific website
- The user asks to fill a form, book something, or make a reservation
- The user asks to check an account status on a web dashboard
- The task requires more than 2 sequential web page interactions

## How it works

1. A browser subagent opens the URL in the remote Chromium instance
2. It navigates, clicks, types, and takes screenshots
3. After each action it snapshots the page to verify progress
4. It returns a summary when done, or asks for human help if blocked

## Human intervention

If the subagent encounters a CAPTCHA, login wall, or 2FA:
- It will stop and report `needs_human: true`
- You (the main agent) must ask the user to open noVNC at `http://<host>:6080`
- The user sees the live browser, solves the blocker, then replies "continue"
- The subagent then resumes from the current page

## Rules

- Never ask the subagent to handle banking PINs or critical passwords
- If a site requires login credentials, ask the user first
- For simple single-page reads, use `fetch` instead (faster)
```

## Security & Guardrails

1. **SSRF prevention:** `browser_navigate` rejects `localhost`, `127.0.0.1`, `::1`, `file://`, `data:` URLs unless explicitly allowlisted
2. **Navigation guard:** Block known malicious TLDs and IP ranges (optional list)
3. **Scope enforcement:** Subagent only gets browser tools (no bash/read/write)
4. **Timeout:** Browser subagent killed after `maxSteps` or `idleTimeoutMs`
5. **Cleanup:** Browser tabs opened by subagent are closed on completion/failure
6. **No credential auto-fill:** Subagent never receives passwords from Vaultwarden skill; user must provide them manually or via noVNC

## Roadmap

### Milestone 1: Core CDP Connection (Day 1) ✅
- [x] `BrowserPool` connect/reuse/disconnect
- [x] `BrowserService` navigate + snapshot
- [x] Unit tests for pool + service (9 tests)

### Milestone 2: Actions + Tools (Day 2) ✅
- [x] click, type, screenshot, scroll, back
- [x] Tool registration in registry
- [x] Unit tests for all tools (7 tests, SSRF guard included)
- [x] E2E test scaffold with `BROWSER_E2E=1` flag

### Milestone 3: Subagent + Human Loop (Day 3) ✅
- [x] `BrowserSubagent` loop runner
- [x] Captcha/login detection heuristics
- [x] `delegate_browser_task` tool in main agent
- [x] Subagent prompt template (inline in `browser.ts`)
- [x] Unit tests for subagent flow (1 test)

### Milestone 4: Skill + Integration (Day 4) ✅
- [x] `web-browsing` skill creation (`src/skills/web-browsing/SKILL.md`)
- [x] AgentBridge integration (skill loading via sync, delegation via tool)
- [x] Config schema + defaults
- [x] E2E tests with real pages (behind `BROWSER_E2E=1`)
- [x] Documentation (`docs/plan/browser-use.md`)

### Milestone 5: Polish (Day 5) ✅
- [x] Screenshots annotated with ref labels (`injectRefLabels` / `removeRefLabels`)
- [x] Dialog handler (auto-dismiss via `page.on('dialog')`)
- [x] Multi-tab support (`browser_list_tabs`, `browser_focus_tab`, `browser_close_tab`)
- [x] Session idle sweeper (background cleanup every 60s, default 5min timeout)
- [ ] Performance: reuse same browser context across subagent turns (optional — future)

## Open Questions

1. **Tab per task or reuse current tab?** → New tab per subagent task. Close on completion. Clean isolation.
2. **Screenshot as vision input to LLM or attachment to user?** → Both. Subagent can send screenshot to vision model for analysis (if vision enabled). Also sent to user as attachment when asking for help.
3. **How to detect "human needed" reliably?** → Heuristic + LLM judgment. If snapshot text contains `captcha`/`verify`/`login`/`2fa` AND subagent failed 3 consecutive actions → ask human.
4. **Do we stream the subagent's thought process?** → No. Subagent runs silently, returns final result or blocker. Main agent streams normally.
5. **What if Chromium crashes during browsing?** → BrowserPool detects disconnect, auto-reconnects on next action. Subagent may need to restart from URL.
