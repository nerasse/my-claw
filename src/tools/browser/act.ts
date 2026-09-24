import { access } from "node:fs/promises";
import { type Tool, type ToolResult } from "../types.ts";
import type { BrowserClient } from "../../browser/client.ts";
import { resolveWorkspacePath } from "../workspace.ts";
import { formatSnapshot, guardUrl, windowed, workspaceOf } from "./state.ts";
import type { BrowserWindows } from "./windows.ts";

/** One action in a chain. The set mirrors the single-action tools, minus the ones that only
 *  read (`snapshot`, `find`, `network`, `screenshot`) and the tabs, which are not steps. */
type Step =
  | { action: "click"; ref: number }
  | { action: "type"; ref: number; text: string; submit?: boolean }
  | { action: "select_option"; ref: number; value: string }
  | { action: "press_key"; key: string; ref?: number }
  | { action: "scroll"; direction?: string; amount?: number; ref?: number }
  | { action: "upload_file"; path: string; ref?: number }
  | { action: "wait_for"; text?: string; ref?: number; timeout_ms?: number }
  | { action: "navigate"; url: string };

const ACTIONS = [
  "click",
  "type",
  "select_option",
  "press_key",
  "scroll",
  "upload_file",
  "wait_for",
  "navigate",
] as const;

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Narrow one raw step, or throw naming the position. The whole chain is validated before any
 *  of it runs, so a typo in step 5 never costs the four steps before it. */
function parseStep(raw: unknown, index: number): Step {
  const at = `steps[${index}]`;
  if (typeof raw !== "object" || raw === null) throw new Error(`${at} is not an object`);
  const o = raw as Record<string, unknown>;
  const action = optionalText(o.action);
  if (action === undefined || !(ACTIONS as readonly string[]).includes(action)) {
    throw new Error(`${at} has unknown action "${String(o.action)}". Known: ${ACTIONS.join(", ")}`);
  }
  const ref = optionalNumber(o.ref);
  // Membership is checked above, so this is the union TS can exhaust over.
  switch (action as Step["action"]) {
    case "click":
      if (ref === undefined) throw new Error(`${at} (click) needs a numeric ref`);
      return { action: "click", ref };
    case "type": {
      const value = optionalText(o.text);
      if (ref === undefined) throw new Error(`${at} (type) needs a numeric ref`);
      if (value === undefined) throw new Error(`${at} (type) needs a non-empty text`);
      return { action: "type", ref, text: value, ...(o.submit === true ? { submit: true } : {}) };
    }
    case "select_option": {
      const value = optionalText(o.value);
      if (ref === undefined) throw new Error(`${at} (select_option) needs a numeric ref`);
      if (value === undefined) throw new Error(`${at} (select_option) needs a value`);
      return { action: "select_option", ref, value };
    }
    case "press_key": {
      const key = optionalText(o.key);
      if (key === undefined) throw new Error(`${at} (press_key) needs a key`);
      return { action: "press_key", key, ...(ref !== undefined ? { ref } : {}) };
    }
    case "scroll": {
      const direction = optionalText(o.direction);
      const amount = optionalNumber(o.amount);
      return {
        action: "scroll",
        ...(direction ? { direction } : {}),
        ...(amount !== undefined ? { amount } : {}),
        ...(ref !== undefined ? { ref } : {}),
      };
    }
    case "upload_file": {
      const path = optionalText(o.path);
      if (path === undefined) throw new Error(`${at} (upload_file) needs a path`);
      return { action: "upload_file", path, ...(ref !== undefined ? { ref } : {}) };
    }
    case "wait_for": {
      const value = optionalText(o.text);
      const timeout = optionalNumber(o.timeout_ms);
      if (value === undefined && ref === undefined && timeout === undefined) {
        throw new Error(`${at} (wait_for) needs text, ref or timeout_ms`);
      }
      return {
        action: "wait_for",
        ...(value ? { text: value } : {}),
        ...(ref !== undefined ? { ref } : {}),
        ...(timeout !== undefined ? { timeout_ms: timeout } : {}),
      };
    }
    case "navigate": {
      const url = optionalText(o.url);
      if (url === undefined) throw new Error(`${at} (navigate) needs a url`);
      return { action: "navigate", url };
    }
  }
}

/** Each ref is resolved by the sidecar at the moment its step runs, so a page that renumbered
 *  its elements mid-chain is followed, not mis-addressed. */
async function runStep(
  client: BrowserClient,
  pages: BrowserWindows,
  args: Record<string, unknown>,
  windowId: number,
  step: Step,
  workspaceDir?: string,
): Promise<void> {
  const pageId = await pages.page(args);
  switch (step.action) {
    case "click":
      await client.click(pageId, step.ref);
      return;
    case "type":
      await client.type(pageId, step.ref, step.text);
      if (step.submit) await client.pressKey(pageId, "Enter", step.ref);
      return;
    case "select_option":
      await client.selectOption(pageId, step.ref, step.value);
      return;
    case "press_key":
      await client.pressKey(pageId, step.key, step.ref);
      return;
    case "scroll":
      await client.scroll(pageId, step.direction ?? "down", step.amount, step.ref);
      return;
    case "wait_for":
      await client.waitFor(pageId, { text: step.text, ref: step.ref, timeoutMs: step.timeout_ms });
      return;
    case "upload_file": {
      const resolved = resolveWorkspacePath(step.path, workspaceDir);
      try {
        await access(resolved);
      } catch {
        throw new Error(`File not found: ${resolved}`);
      }
      await client.uploadFile(pageId, [resolved], step.ref);
      return;
    }
    case "navigate": {
      await guardUrl(step.url);
      const result = await client.navigate(step.url, { pageId, windowId });
      pages.moved(args, windowId, result.pageId, false);
      return;
    }
  }
}

/**
 * A chain of actions in one call. The single-action tools each return a snapshot, which is what
 * makes them safe but also what costs a full round trip and a full snapshot per action; a chain
 * runs the same calls back to back and answers with ONE snapshot at the end. It stops at the
 * first step that fails, because a blind chain that keeps going acts on the wrong page.
 */
export function createBrowserActTool(client: BrowserClient, pages: BrowserWindows, workspaceDir?: string): Tool {
  return {
    name: "browser_act",
    description:
      "Run a sequence of actions in ONE step, and get a single page snapshot at the end instead of one per action. Use it for a safe, known sequence (fill a form field by field, then submit) where you do not need to look between the actions. Each step's ref is re-resolved when it runs, and the chain stops at the first failure. Same actions as the single tools: click, type (submit:true presses Enter on the field), select_option, press_key, scroll, upload_file, wait_for, navigate.",
    parameters: windowed({
      type: "object",
      properties: {
        steps: {
          type: "array",
          description: "Ordered actions. Each is {action, ...}; see the tool description for the fields per action.",
          items: { type: "object" },
        },
        stop_on_error: {
          type: "boolean",
          description: "Stop at the first failing step (default true). Set false to run every step and report them all.",
        },
      },
      required: ["steps"],
    }),
    async execute(args): Promise<ToolResult> {
      const raw = args["steps"];
      if (!Array.isArray(raw) || raw.length === 0) {
        return { success: false, output: "", error: "browser_act needs a non-empty steps array." };
      }
      let steps: Step[];
      try {
        steps = raw.map((step, index) => parseStep(step, index));
      } catch (e) {
        return { success: false, output: "", error: `Invalid chain, nothing was executed: ${String(e)}` };
      }

      let windowId: number;
      try {
        windowId = await pages.window(args);
      } catch (e) {
        return { success: false, output: "", error: `Nothing was executed: ${String(e)}` };
      }

      const stopOnError = args["stop_on_error"] !== false;
      const signal = args["__signal"] instanceof AbortSignal ? args["__signal"] : undefined;
      const dir = workspaceOf(args, workspaceDir);
      const done: { index: number; action: string; ok: boolean; error?: string }[] = [];
      let stoppedAt: number | undefined;

      for (let i = 0; i < steps.length; i++) {
        if (signal?.aborted) break;
        const step = steps[i]!;
        try {
          await runStep(client, pages, args, windowId, step, dir);
          done.push({ index: i, action: step.action, ok: true });
        } catch (e) {
          done.push({ index: i, action: step.action, ok: false, error: String(e) });
          stoppedAt = i;
          if (stopOnError) break;
        }
      }

      let snapshotText: string;
      try {
        snapshotText = formatSnapshot(await client.snapshot(await pages.page(args)));
      } catch (e) {
        snapshotText = `(snapshot unavailable: ${String(e)})`;
      }
      const okCount = done.filter((d) => d.ok).length;
      const head = `${okCount}/${steps.length} steps ok${stoppedAt !== undefined ? `, stopped at step ${stoppedAt + 1}` : ""}.`;
      const lines = done.map((d) => `${d.ok ? "ok  " : "FAIL"} ${d.index + 1}. ${d.action}${d.error ? `: ${d.error}` : ""}`).join("\n");
      const report = `${head}\n${lines}\n\n${snapshotText}`;
      return stoppedAt === undefined
        ? { success: true, output: report }
        : { success: false, output: "", error: report };
    },
  };
}
