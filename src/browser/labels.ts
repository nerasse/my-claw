// @ts-nocheck
// Code executed inside browser via Playwright page.evaluate()
import type { Page } from "playwright-core";

export async function injectRefLabels(page: Page): Promise<void> {
  await page.evaluate(() => {
    const elements = document.querySelectorAll("[__ref]");
    for (const el of Array.from(elements)) {
      const ref = el.getAttribute("__ref");
      if (!ref) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;

      const label = document.createElement("div");
      label.textContent = ref;
      label.style.cssText = `
        position: fixed;
        left: ${rect.left}px;
        top: ${rect.top}px;
        background: rgba(255, 0, 0, 0.8);
        color: white;
        font-size: 12px;
        font-weight: bold;
        padding: 2px 6px;
        border-radius: 3px;
        z-index: 999999;
        pointer-events: none;
        font-family: monospace;
      `;
      label.setAttribute("data-my-claw-label", ref);
      document.body.appendChild(label);
    }
  });
}

export async function removeRefLabels(page: Page): Promise<void> {
  await page.evaluate(() => {
    const labels = document.querySelectorAll("[data-my-claw-label]");
    for (const el of Array.from(labels)) {
      el.remove();
    }
  });
}
