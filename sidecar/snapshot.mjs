// Page snapshotting: ref stamping, the readable aria tree, and the ref label overlay.
import crypto from "node:crypto";

const SCREENSHOT_DIR = "/tmp";
const MAX_REFS = 400;

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

// Playwright's ariaSnapshot({ ref: true }) emits no usable ref markers in this
// build, so we assign our own: stamp every visible interactive element with a
// __ref attribute (clicked via [__ref="N"], also used by the label overlay) and
// list them. The aria tree is kept for readable page context.
export async function snapshotPage(page) {
  const ariaTree = await page.locator("body").ariaSnapshot().catch(() => "");

  const interactive = await page.evaluate((max) => {
    // role=option/listbox/menuitemradio/treeitem are load-bearing: custom React
    // comboboxes render their options as plain divs carrying those roles. Without them
    // in this list the options appear in the aria tree but get no ref, so the agent can
    // see them and still be unable to click any of them.
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
    const viewportHeight = window.innerHeight;
    const viewportWidth = window.innerWidth;
    const candidates = [];
    for (const el of Array.from(document.querySelectorAll(SELECTOR))) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const style = window.getComputedStyle(el);
      if (style.visibility === "hidden" || style.display === "none") continue;
      const inViewport =
        rect.bottom > 0 && rect.top < viewportHeight && rect.right > 0 && rect.left < viewportWidth;
      candidates.push({ el, inViewport });
    }
    // Viewport-first: the ref budget is capped, so off-screen page chrome (footers, hidden
    // menus) must never consume the budget before the element the agent is looking at.
    const ordered = [
      ...candidates.filter((c) => c.inViewport),
      ...candidates.filter((c) => !c.inViewport),
    ];
    const lines = [];
    let ref = 0;
    for (const { el, inViewport } of ordered) {
      if (ref >= max) break;
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
      lines.push(`[__ref="${ref}"] ${role} "${name}"${inViewport ? "" : " (offscreen — scroll to reach)"}`);
    }
    return lines.join("\n");
  }, MAX_REFS);

  const raw = interactive
    ? `${ariaTree}\n\nInteractive elements (click/type by ref):\n${interactive}`
    : ariaTree;
  return { raw, refs: extractRefs(raw) };
}

export async function injectRefLabels(page) {
  await page.evaluate(() => {
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
  });
}

export async function removeRefLabels(page) {
  await page.evaluate(() => {
    for (const el of Array.from(document.querySelectorAll("[data-my-claw-label]"))) {
      el.remove();
    }
  });
}
