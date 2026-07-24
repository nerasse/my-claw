# Browser Subagent Autonomy (Full Actions)

Spec for turning the browser subagent from a *navigate/click/type* driver into an agent
that completes real web tasks on its own. Architecture (Bun -> HTTP -> Node sidecar ->
Playwright -> Chromium) is unchanged and described in `docs/browser.md`; this document
only covers the capability gap, the new tool surface, and the security model.

## Why

Two hard blockers in the same session (Instagram account setup, 2026-07-24), both ending in
`browser_done(needs_human=true)`:

1. **Custom combobox unusable** — birthday Month/Day/Year. The options were visible in the
   aria snapshot ("option July", "25", "1997") but got **no ref number**, so `browser_click`
   could not target them and `browser_type` did not apply (not an `input`/`textarea`).
2. **File upload impossible** — profile photo. Clicking "Add a profile photo" triggers an
   `<input type="file">`; the subagent reported "native OS dialog, out of reach of DOM-based
   automation" and stopped.

The main agent then worked around #2 from outside the sandbox: raw CDP over `bash`,
`DOM.setFileInputFiles` on node id 154. It worked, but it bypassed the sidecar, the workspace
sandbox, and the guardrails, and it contradicts `src/skills/web-browsing/SKILL.md`.

## Root causes (both are gaps, not platform limits)

| # | Root cause | Evidence |
|---|---|---|
| 1 | The ref-stamping selector list has no `[role=option]` (nor `listbox`, `menuitemradio`, `treeitem`, `slider`, `spinbutton`, `[tabindex]`, `label`, `summary`) | `sidecar/server.mjs:118-123` |
| 2 | The sidecar exposes no upload endpoint at all | `sidecar/server.mjs:188-295` |

Playwright handles both natively: `locator.setInputFiles()` writes into a file input
**without ever opening the OS dialog**, and the `filechooser` event intercepts the picker when
a site opens it programmatically. Neither needs raw CDP.

**Design principle that follows: Playwright primitives first, raw CDP as a gated escape hatch
of last resort.** Shipping CDP as the primary answer would add a large risk surface while
leaving the actual holes (selector coverage, no upload) open.

## Secondary limits found while auditing

- `MAX_REFS = 200` with no ordering: on a dense SPA the cap can be consumed by
  offscreen chrome before reaching the element that matters (`sidecar/server.mjs:108`).
- No traversal into **iframes** or **shadow DOM** — stamping runs on the main document only.
- No `scroll`: refs only cover what is currently visible, so anything below the fold is
  unreachable without a navigation.
- No `press_key`: most custom comboboxes are keyboard-operable (`ArrowDown`/`Enter`) and this
  alone would have solved blocker #1.
- Give-up rule fires early: "no progress after 3 consecutive steps -> needs_human"
  (`src/agent/subagents/browser.ts:54`), with a 30-step budget
  (`src/agent/subagents/browser.ts:32`).
- One global 90s timeout for every sidecar call (`src/browser/client.ts:4`).

## Tool surface

New tools are registered in the subagent registry (`src/agent/subagents/browser.ts:116-124`)
and backed by one sidecar endpoint each, plus a `BrowserClient` method.

### Phase 0 — mechanical actions

| Tool | Sidecar / Playwright | Notes |
|---|---|---|
| `browser_upload_file(ref, path)` | `locator.setInputFiles`, fallback `page.waitForEvent("filechooser")` raced with a click | Path is resolved **in Bun** via `resolveWorkspacePath` (`src/tools/workspace.ts`) before the call; the sidecar only ever receives an absolute, validated path |
| `browser_select_option(ref, value)` | `locator.selectOption` for native `<select>`; otherwise click-open then match an option by accessible text | Covers both the native and the React-combobox case |
| `browser_press_key(key, ref?)` | `locator.press` / `page.keyboard.press` | `Enter`, `Tab`, `Escape`, `ArrowDown`, `PageDown`... |
| `browser_scroll(direction, amount?)` | `page.mouse.wheel` / `locator.scrollIntoViewIfNeeded` | Unlocks below-the-fold content |

Plus, in the same phase: extend the selector list with
`[role=option]`, `[role=listbox]`, `[role=menuitemcheckbox]`, `[role=menuitemradio]`,
`[role=treeitem]`, `[role=slider]`, `[role=spinbutton]`, `[role=searchbox]`, `label`,
`summary`, `[tabindex]:not([tabindex="-1"])`; raise `MAX_REFS` to 400 and **rank
viewport-first** (visible elements get the low refs) so the cap never hides the target.

### Phase 1 — self-recovery

| Tool | Sidecar / Playwright | Notes |
|---|---|---|
| `browser_click_at(x, y)` | `page.mouse.click` | **Coordinates are normalized fractions in `[0,1]`**, multiplied by the live viewport in the sidecar. Pixel coordinates would break as soon as a screenshot is downscaled before reaching the model (`src/media/image.ts`); fractions are resize-proof. Every screenshot response also returns the viewport size. |
| `browser_wait_for(text? , ref?, ms?)` | `waitForSelector` / `waitForFunction` / `waitForTimeout` | Replaces blind retry loops that burn the step budget |
| `browser_hover(ref)` | `locator.hover` | Menus that only open on hover |
| `browser_drag(from_ref, to_ref)` | `locator.dragTo` | Sliders, reorderable lists |

Plus: stamp refs **inside iframes and shadow roots** (Playwright `page.frames()` + a
`shadowRoot` walk in the injected script), raise the default step budget to 60, and rewrite
the give-up rule around the escalation ladder below.

### Phase 2 — low level, off by default

| Tool | Gate | Notes |
|---|---|---|
| `browser_eval(js)` | `browser.allowEval` | Arbitrary JS in the page, JSON-serializable return only, output size capped |
| `browser_cdp(method, params)` | `browser.allowCdp` + method allowlist | Raw CDP through `page.context().newCDPSession(page)` — **inside** the sidecar, so the sidecar stays the single owner of the browser |
| `browser_handle_dialog(accept, text?)` | none | Overrides the auto-accept default (`docs/browser.md:61`) for the next dialog only; auto-accept remains the default so a dialog can never hang a run |
| `browser_download_wait(timeout_ms?)` | none | `page.on("download")` saved into a sandboxed download dir |
| `browser_pdf()` | none | `page.pdf()` for archiving a result |

## Escalation ladder

Replaces "3 steps without progress -> needs_human". The subagent must walk the ladder before
handing off, and must state in its summary which rungs it tried:

1. `ref` action (`click` / `type` / `select_option`)
2. keyboard (`press_key`) — the intended path for custom comboboxes
3. `scroll` + fresh snapshot, then retry the ref
4. `wait_for` (the element may simply not be there yet)
5. `screenshot(labels=true)` + `click_at(x, y)` — vision fallback, works on anything the DOM
   does not expose (canvas, WebGL, exotic overlays)
6. `eval` (if enabled)
7. `cdp` (if enabled)
8. `browser_done(needs_human=true)`

**`needs_human` becomes reserved for genuinely human barriers**: CAPTCHA, bot-check, 2FA/OTP,
payment confirmation, or an explicit user decision. A missing primitive is a **gap to report**,
never a handoff — the ladder exists so blockers #1 and #2 can no longer reach rung 8.

As shipped in P0 the ladder runs 1-4 plus a labelled screenshot, and a failed ladder ends the
task with `needs_human=false` naming the rungs tried. Rungs 5 (`click_at`), 6 (`eval`) and 7
(`cdp`) are wired in with P1 and P2.

## Security model

The subagent reads **untrusted page content** and the browser is logged into **real accounts**
(Instagram, and whatever else the persistent profile holds). That makes prompt injection the
main threat, and it is the reason `eval`/`cdp` are opt-in.

- **`eval` implies cookie access.** Any JS in the page can read non-`HttpOnly` cookies, so
  "block the CDP cookie methods" is not a real control. The honest controls are: both flags
  **default off**, an **audit log entry for every `eval`/`cdp`/`upload` call**
  (`src/utils/logger.ts`), and capped output.
- **CDP allowlist** (when `allowCdp` is on): `DOM.*`, `Input.*`, `Emulation.*`,
  `Page.navigate|captureScreenshot|printToPDF`, `Runtime.evaluate`.
  **Hard denylist**: `Browser.*`, `Target.*`, `Storage.*`, `Security.*`, `Fetch.*` and
  `Network.setCookie|getCookies|getAllCookies` — request interception would expose auth
  headers, and `Target.*` would let the subagent escape its own page.
- **Uploads are sandboxed**: only paths inside the workspace, validated in Bun before the
  sidecar sees them. Downloads land in a dedicated directory, never the workspace root.
- **The subagent summary is untrusted input** for the main agent: it is page-derived text that
  a hostile site can shape. `delegate_browser_task` output must be wrapped as untrusted data
  (`src/agent/prompt/anti-injection.ts`), and secret-looking strings redacted from it.
- **Unchanged**: SSRF guard on `browser_navigate`, one-task-at-a-time serialization,
  per-subagent page state, `AbortSignal` threading.

## Config

```json
{
  "browser": {
    "maxSteps": 60,
    "allowEval": false,
    "allowCdp": false,
    "cdpAllowlist": ["DOM.*", "Input.*", "Runtime.evaluate"],
    "downloadDir": "~/.my-claw/workspace/downloads",
    "perToolTimeoutMs": { "default": 30000, "navigate": 45000, "upload": 60000 }
  }
}
```

Extends `BrowserConfig` (`src/core/config.ts:140`). Per-tool timeouts replace the single
90s global (`src/browser/client.ts:4`).

**`"browser"` must be added to `HOT_OBJECT_SECTIONS` (`src/core/config-watcher.ts:35`)** —
a key absent from every watcher list is silently ignored, never applied and never flagged.

## Phases and acceptance criteria

| Phase | Content | Done when | Effort |
|---|---|---|---|
| **P0 — DONE** | Selector coverage, `MAX_REFS` 400 + viewport-first, `upload_file`, `select_option`, `press_key`, `scroll` | Shipped. Both blockers verified against a real Chromium on local fixtures (`tests-e2e/browser/basic.test.ts`: options get refs, `select_option` commits the value, upload works both on the hidden input and through the trigger button) — no CDP involved | ~1 d |
| **P1** | `click_at` (normalized), `wait_for`, `hover`, `drag`, iframe/shadow DOM, ladder in the prompt, budget 60 | An element with no ref at all is still actionable via the vision fallback; `needs_human` only fires on human barriers | ~1-2 d |
| **P2** | `eval`, `cdp` (allowlist), `handle_dialog`, downloads, `pdf` | Flags off by default; every call audited; denylist enforced by a unit test | ~1 d |
| **P3** | Config + hot-reload wiring, per-tool timeouts, audit log, tests, docs, skill | `bun test` green, e2e green, `docs/browser.md` updated | ~1 d |

P0 carries most of the real value. Doing P2 first would ship the *feeling* of power while
leaving the actual holes open.

## Tests

- **Fixtures, not Instagram.** `tests-e2e/browser/fixtures/` gets a page with a React-style
  combobox (`div role="combobox"` + `div role="option"`) and an `<input type="file">`, so the
  two regressions are covered deterministically and offline.
- **Unit** (mocked sidecar HTTP, Bun): one case per new tool, workspace-escape rejection on
  `upload_file`, CDP denylist rejection, normalized-coordinate conversion.
- **E2E** (`BROWSER_E2E=1`, real sidecar + Chromium): select an option in the custom combobox,
  upload a file, click by coordinates.
- `bun test` must never touch the real `~/.my-claw` (`tests/setup.ts` handles `MY_CLAW_DIR`).

## Rejected alternatives

- **Raw CDP from the main agent via `bash`** (what happened in the session): bypasses the
  sidecar, the workspace sandbox and the audit trail, and gives the main agent a second,
  unmanaged path to the browser. Kept only as a narrow, disclosed last resort until P0/P1
  land — see the skill.
- **CDP as the primary action layer**: heavier, less portable, and it would not have fixed
  blocker #1 (a missing selector), only papered over it.
- **A second Chromium profile for risky actions**: doubles the infra and loses the persistent
  logins that make the subagent useful.
- **Keyword auto-detection of blockers**: already rejected for the human handoff
  (`docs/browser.md:54`), same reasoning here — the ladder is the agent's own judgment.

## Where

```
sidecar/server.mjs                     # new endpoints (upload, select, key, scroll, wait, eval, cdp...)
src/browser/client.ts                  # one method per endpoint + per-tool timeouts
src/browser/types.ts                   # viewport in screenshot result, upload/cdp payloads
src/tools/browser.ts                   # tool factories + workspace validation for uploads
src/agent/subagents/browser.ts         # registry wiring, BROWSER_PROMPT ladder, budget
src/core/config.ts                     # BrowserConfig extension
src/core/config-watcher.ts             # "browser" in HOT_OBJECT_SECTIONS
src/skills/web-browsing/SKILL.md       # main-agent rules (bash/CDP boundary)
docs/browser.md                        # architecture, updated as phases land
docs/browser-autonomy.md               # this file
```
