// Page snapshotting: ref stamping, the readable aria tree, and the ref label overlay.
import crypto from "node:crypto";

const SCREENSHOT_DIR = "/tmp";

export function screenshotPath() {
  return `${SCREENSHOT_DIR}/browser-${crypto.randomUUID()}.png`;
}

function extractRefs(snapshot) {
  const refs = [];
  const regex = /\[__ref="(\d+)"\]/g;
  let match;
  while ((match = regex.exec(snapshot)) !== null) {
    refs.push(Number(match[1]));
  }
  return [...new Set(refs)].sort((a, b) => a - b);
}

// Runs inside the page (once per frame). Playwright's ariaSnapshot({ ref: true }) emits no
// usable ref markers in this build, so we assign our own: stamp every visible interactive
// element with a __ref attribute (acted on via [__ref="N"], also used by the label overlay).
function stampFrame({ start }) {
  // role=option/listbox/menuitemradio/treeitem are load-bearing: custom React comboboxes
  // render their options as plain divs carrying those roles. Without them in this list the
  // options appear in the aria tree but get no ref, so the agent can see them and still be
  // unable to click any of them.
  const SELECTOR = [
    "a[href]", "button", "input:not([type=hidden])", "select", "textarea",
    "[role=button]", "[role=link]", "[role=textbox]", "[role=searchbox]",
    "[role=checkbox]", "[role=radio]", "[role=combobox]", "[role=listbox]",
    "[role=option]", "[role=menuitem]", "[role=menuitemcheckbox]",
    "[role=menuitemradio]", "[role=treeitem]", "[role=tab]", "[role=switch]",
    "[role=slider]", "[role=spinbutton]",
    "label", "summary", '[tabindex]:not([tabindex="-1"])',
    "[contenteditable='']", "[contenteditable=true]", "[onclick]",
  ].join(",");

  for (const el of Array.from(document.querySelectorAll("[__ref]"))) {
    el.removeAttribute("__ref");
  }

  // Web components hide their controls in shadow roots, which querySelectorAll does not
  // enter: without this walk a whole class of sites exposes zero refs.
  const found = [];
  const walk = (root) => {
    for (const el of Array.from(root.querySelectorAll("*"))) {
      if (el.matches(SELECTOR)) found.push(el);
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };
  walk(document);

  const viewportHeight = window.innerHeight;
  const viewportWidth = window.innerWidth;
  const candidates = [];
  for (const el of found) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    const style = window.getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none") continue;
    const inViewport =
      rect.bottom > 0 && rect.top < viewportHeight && rect.right > 0 && rect.left < viewportWidth;
    candidates.push({ el, inViewport });
  }
  // Viewport-first: what the agent is looking at is numbered, and read, before the page chrome.
  const ordered = [
    ...candidates.filter((c) => c.inViewport),
    ...candidates.filter((c) => !c.inViewport),
  ];

  const lines = [];
  const entries = [];
  const seq = new Map();
  let ref = start - 1;
  for (const { el, inViewport } of ordered) {
    ref += 1;
    el.setAttribute("__ref", String(ref));
    const role = el.getAttribute("role") || el.tagName.toLowerCase();
    const name = (
      el.getAttribute("aria-label") ||
      el.getAttribute("placeholder") ||
      (typeof el.value === "string" ? el.value : "") ||
      el.innerText ||
      el.getAttribute("title") ||
      el.getAttribute("name") ||
      ""
    ).replace(/\s+/g, " ").trim().slice(0, 80);
    // The fingerprint survives renumbering: role, name, and which same-named element this was.
    const base = `${role}|${name}`;
    const nth = (seq.get(base) || 0) + 1;
    seq.set(base, nth);
    entries.push({ ref, key: `${base}|${nth}` });
    lines.push(`[__ref="${ref}"] ${role} "${name}"${inViewport ? "" : " (offscreen — scroll to reach)"}`);
  }
  return { lines: lines.join("\n"), used: lines.length, entries };
}

/** Snapshots every frame of the page with ONE global ref counter, so a ref is unique
 *  across the main document and all iframes. Content inside an iframe is otherwise
 *  invisible to the agent: it lives in a separate JS context. */
export async function snapshotPage(page, pageId) {
  const ariaTree = await page.locator("body").ariaSnapshot().catch(() => "");

  const { interactive, entries } = await stampFrames(page);
  rememberRefs(pageId, entries);
  const raw = interactive
    ? `${ariaTree}\n\nInteractive elements (click/type by ref):\n${interactive}`
    : ariaTree;
  return { raw, refs: extractRefs(raw) };
}

/** pageId -> (ref -> fingerprint), refreshed on every stamp; small, bounded, per sidecar life. */
const refKeys = new Map();

function rememberRefs(pageId, entries) {
  if (!pageId) return;
  if (!refKeys.has(pageId) && refKeys.size >= 64) {
    const oldest = refKeys.keys().next().value;
    if (oldest !== undefined) refKeys.delete(oldest);
  }
  refKeys.set(pageId, new Map(entries.map((entry) => [entry.ref, entry.key])));
}

async function stampFrames(page) {
  const blocks = [];
  const entries = [];
  let next = 1;
  for (const frame of page.frames()) {
    const result = await frame
      .evaluate(stampFrame, { start: next })
      .catch(() => null); // a cross-origin or detached frame is skipped, never fatal
    if (!result?.lines) continue;
    const label = frame === page.mainFrame() ? "" : `\n[iframe ${frame.url().slice(0, 120)}]\n`;
    blocks.push(`${label}${result.lines}`);
    for (const entry of result.entries || []) entries.push(entry);
    next += result.used;
  }
  return { interactive: blocks.join("\n"), entries };
}

/**
 * A ref that no longer resolves: restamp the page and find the element carrying the same
 * fingerprint (role, name, nth of that pair). One unique match means the element survived a
 * re-render under a new number, and the caller retries on it; no match (or a different page)
 * leaves the caller's stale-ref error untouched. Nothing else on the page is acted on.
 */
export async function healRef(page, pageId, ref) {
  const known = refKeys.get(pageId)?.get(ref);
  if (!known) return null;
  const { entries } = await stampFrames(page);
  rememberRefs(pageId, entries);
  const matches = entries.filter((entry) => entry.key === known);
  return matches.length === 1 ? matches[0].ref : null;
}

/** Locator for a ref plus the frame that owns it, searched across every frame. Playwright
 *  CSS pierces open shadow roots on its own, so only iframes need the explicit walk. The
 *  frame is returned because follow-up lookups (a combobox's options) must stay in it. */
export async function resolveRef(page, ref) {
  for (const frame of page.frames()) {
    const locator = frame.locator(`[__ref="${ref}"]`);
    if ((await locator.count().catch(() => 0)) > 0) return { locator, frame };
  }
  throw new Error(`Ref ${ref} not found on the page — it is stale, re-snapshot and use the new refs.`);
}

export async function injectRefLabels(page) {
  for (const frame of page.frames()) {
    await frame
      .evaluate(() => {
        const elements = document.querySelectorAll("[__ref]");
        for (const el of Array.from(elements)) {
          const ref = el.getAttribute("__ref");
          if (!ref) continue;
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;
          const label = document.createElement("div");
          label.textContent = ref;
          label.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;background:rgba(255,0,0,0.8);color:white;font-size:12px;font-weight:bold;padding:2px 6px;border-radius:3px;z-index:999999;pointer-events:none;font-family:monospace;`;
          label.setAttribute("data-my-claw-label", ref);
          document.body.appendChild(label);
        }
      })
      .catch(() => undefined);
  }
}

export async function removeRefLabels(page) {
  for (const frame of page.frames()) {
    await frame
      .evaluate(() => {
        for (const el of Array.from(document.querySelectorAll("[data-my-claw-label]"))) {
          el.remove();
        }
      })
      .catch(() => undefined);
  }
}
