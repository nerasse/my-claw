import type { MyClawConfig } from "../../core/config.ts";
import { recordApiCall } from "../../analytics/usage-db.ts";
import type { Attachment } from "../../channels/types.ts";
import { chatCompletion, type ChatMessage, type LlmResponse, type ToolCall } from "../../llm/provider.ts";
import { trimToContextWindow, estimateTokens } from "../../llm/tokens.ts";
import { resolveOpenAiLlmConfig } from "../../llm/resolver.ts";
import { toOpenAiToolDefinitions } from "../../llm/openai-format.ts";
import { BrowserClient } from "../../browser/client.ts";
import { ToolRegistry } from "../../tools/registry.ts";
import {
  createBrowserNavigateTool,
  createBrowserSnapshotTool,
  createBrowserClickTool,
  createBrowserTypeTool,
  createBrowserSelectOptionTool,
  createBrowserUploadFileTool,
  createBrowserPressKeyTool,
  createBrowserScrollTool,
  createBrowserScreenshotTool,
  createBrowserListTabsTool,
  createBrowserFocusTabTool,
  createBrowserCloseTabTool,
  createBrowserPageState,
} from "../../tools/browser/index.ts";
import { loadAllPromptFiles, loadCorePrompt } from "../prompt/loader.ts";
import { scanForInjection } from "../prompt/anti-injection.ts";

export interface BrowserSubagentResult {
  success: boolean;
  summary: string;
  needs_human: boolean;
  current_url?: string;
  attachments?: Attachment[];
}

const DEFAULT_MAX_STEPS = 30;

const BROWSER_PROMPT = `You are a web browsing assistant. Your job is to complete tasks on websites using the available browser tools.

Available tools:
- browser_navigate(url, new_tab?): Go to a URL. Reuses the CURRENT tab by default — it does NOT open a new tab each call. Pass new_tab=true only when you genuinely need a separate tab. Returns a fresh snapshot of the page.
- browser_snapshot(): Re-read the page accessibility tree with ref numbers WITHOUT acting. navigate/click/type already return a fresh snapshot — do NOT call this after them; use it only when you need to re-check the page on its own.
- browser_click(ref): Click an element by its ref number. Returns a fresh snapshot.
- browser_type(ref, text): Type text into a field by its ref number. Returns a fresh snapshot.
- browser_select_option(ref, value): Choose a value in a dropdown, passing the ref OF THE DROPDOWN and the visible label of the option. Works for native <select> and for custom comboboxes whose options you cannot click directly. Always prefer this over clicking an option yourself.
- browser_upload_file(path, ref?): Upload a local file (profile photo, attachment, document). This is what handles the native OS file dialog. Pass the absolute path; leave ref out — the file input is normally hidden and has no ref.
- browser_press_key(key, ref?): Press Enter, Tab, Escape, ArrowDown, ArrowUp, PageDown... Often the only way to drive a custom dropdown or submit a form with no visible button.
- browser_scroll(direction?, amount?, ref?): Scroll the page, or bring one element into view via ref. Required for elements marked "offscreen" and to load lazy content.
- browser_screenshot(full_page?, labels?): Capture a screenshot. Use when stuck or to show the user the page. Set labels=true to overlay ref numbers on elements.
- browser_list_tabs(): List all open tabs with their index and URL.
- browser_focus_tab(index): Switch to a different tab by its index (from browser_list_tabs).
- browser_close_tab(index): Close a tab by its index.
- browser_done(summary, needs_human?): Call this when the task is finished, or when you are blocked and need a human to take over.

Rules:
0. REUSE OPEN TABS. The browser is shared and stays open between tasks; the tabs already open are listed below under "Open browser tabs". Before opening anything, check that list: if a relevant tab already exists, continue in it with browser_focus_tab instead of navigating a fresh one. Reuse tabs as much as possible, but cleanly — never clobber an unrelated tab, and do not open duplicates. Only create a new tab (new_tab=true) when no existing tab fits.
1. DISMISS OVERLAYS FIRST. If a cookie/consent banner, GDPR popup, newsletter modal, or app-install prompt covers the page, close it BEFORE anything else (click "Accept", "Reject", "Continue", the X, ...). NEVER take a screenshot for the user while such an overlay is still covering the page.
2. Every step costs budget. navigate/click/type already return the new page state — do NOT waste a step calling browser_snapshot right after them.
3. Use only the ref numbers from the latest snapshot for click and type.
4. Navigate autonomously. Do NOT stop at login forms, password fields, or sign-in pages — fill them in yourself if you have the needed information.
5. Call browser_done with needs_human=true ONLY for a barrier that genuinely requires a human being: a CAPTCHA, a bot-check ("I'm not a robot", Cloudflare), a 2FA/OTP code you do not have, a payment confirmation, or a decision only the user can make. A dropdown that resists, a file dialog, or an element you cannot reach is NOT one of these — see rule 6. Explain what is blocking in the summary; the user takes over the live browser and the task resumes.
6. NEVER HAND OVER A MECHANICAL PROBLEM. When an element does not respond, work down this ladder before concluding anything:
   a. re-snapshot and use the FRESH ref — refs are renumbered on every page update, so a stale ref silently targets the wrong element
   b. dropdown: browser_select_option on the dropdown's own ref (never hunt for the option's ref)
   c. file, photo or attachment: browser_upload_file with the absolute path
   d. browser_press_key — ArrowDown/Enter to drive a dropdown, Escape to close an overlay, Tab to leave a field
   e. browser_scroll to bring the element into view, then retry the action
   f. browser_screenshot(labels=true) to see what is actually on screen
   If the whole ladder fails, finish with browser_done and needs_human=FALSE, stating precisely which rungs you tried — that is a tooling gap to fix, not a reason to summon the user.
7. When the task is complete, call browser_done with a summary (needs_human defaults to false). Include everything useful you found — the summary is all the caller gets.
8. Use browser_screenshot to capture visual evidence of results — these screenshots are delivered to the user. Only screenshot a page that is fully loaded and free of overlays.`;

async function buildBrowserSystemPrompt(): Promise<string> {
  const layers: string[] = [];

  layers.push(await loadCorePrompt());

  const files = await loadAllPromptFiles();
  for (const name of ["SOUL.md", "USER.md"] as const) {
    const content = files[name];
    if (content) {
      const safe = scanForInjection(content, name);
      if (safe) layers.push(safe);
    }
  }

  layers.push(BROWSER_PROMPT);
  return layers.filter(Boolean).join("\n\n");
}

/** Infrastructure failures: the browser sidecar or the shared Chromium behind it
 *  is unreachable. These are NOT human-solvable blockers — never route them to a
 *  noVNC handoff. Deliberately excludes generic page "timeout" (a slow site is
 *  a normal tool failure the agent can retry, not an infra outage). */
const INFRA_ERROR_SIGNATURES = [
  "econnrefused",
  "econnreset",
  "ehostunreach",
  "enetunreach",
  "sidecar unreachable",
  "connectovercdp",
  "websocket error",
  "browser has been closed",
  "target page, context or browser has been closed",
  "browser is closed",
  "connection closed",
];
// NB: a user-closed tab is handled at the sidecar (closed pages are pruned, so the next op returns
// "Unknown pageId" — a normal tool failure the agent recovers from by navigating fresh — rather
// than the Playwright "target closed" message that would land here).

export function isBrowserInfraError(error?: string): boolean {
  if (!error) return false;
  const lower = error.toLowerCase();
  return INFRA_ERROR_SIGNATURES.some((s) => lower.includes(s));
}

export class BrowserSubagent {
  private client: BrowserClient;
  private toolRegistry: ToolRegistry;
  private maxSteps: number;

  constructor(
    private config: MyClawConfig,
    private sidecarUrl: string,
  ) {
    this.maxSteps = config.browser?.maxSteps ?? DEFAULT_MAX_STEPS;
    this.client = new BrowserClient(sidecarUrl, config.browser?.viewport);
    this.toolRegistry = new ToolRegistry();
    const pageState = createBrowserPageState();
    this.toolRegistry.register(createBrowserNavigateTool(this.client, pageState));
    this.toolRegistry.register(createBrowserSnapshotTool(this.client, pageState));
    this.toolRegistry.register(createBrowserClickTool(this.client, pageState));
    this.toolRegistry.register(createBrowserTypeTool(this.client, pageState));
    this.toolRegistry.register(createBrowserSelectOptionTool(this.client, pageState));
    this.toolRegistry.register(createBrowserUploadFileTool(this.client, pageState, config.workspace));
    this.toolRegistry.register(createBrowserPressKeyTool(this.client, pageState));
    this.toolRegistry.register(createBrowserScrollTool(this.client, pageState));
    this.toolRegistry.register(createBrowserScreenshotTool(this.client, pageState));
    this.toolRegistry.register(createBrowserListTabsTool(this.client));
    this.toolRegistry.register(createBrowserFocusTabTool(this.client, pageState));
    this.toolRegistry.register(createBrowserCloseTabTool(this.client));
    this.toolRegistry.register({
      name: "browser_done",
      description: "Signal that the task is finished. Set needs_human=true only if you are blocked by something you cannot resolve yourself (CAPTCHA, bot-check, 2FA/OTP).",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string", description: "Summary of what was done, or what is blocking" },
          needs_human: { type: "boolean", description: "True if a human must take over the live browser to resolve a blocker" },
        },
        required: ["summary"],
      },
      async execute(args) { return { success: true, output: String(args["summary"] ?? "done") }; },
    });
  }

  async run(task: string, startUrl?: string, signal?: AbortSignal): Promise<BrowserSubagentResult> {
    const systemPrompt = `${await buildBrowserSystemPrompt()}\n\n${await this.formatOpenTabs()}`;
    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: `Task: ${task}${startUrl ? `\nStart URL: ${startUrl}` : ""}` },
    ];

    let currentUrl = startUrl ?? "";
    const allAttachments: Attachment[] = [];

    try {
    for (let step = 0; step < this.maxSteps; step++) {
      if (signal?.aborted) {
        return {
          success: false,
          needs_human: false,
          summary: "Stopped by user.",
          current_url: currentUrl,
          attachments: allAttachments,
        };
      }

      const openaiTools = toOpenAiToolDefinitions(this.toolRegistry.getForAgent("general", this.config.tools?.disabled));

      let response: LlmResponse;
      const llmConfig = resolveOpenAiLlmConfig(this.config.llm);
      // Snapshots are large; without trimming, a 30-step run can outgrow the model context.
      const toolSchemaTokens = estimateTokens(JSON.stringify(openaiTools));
      const trimmed = trimToContextWindow(messages, llmConfig.limit?.context, toolSchemaTokens);
      const browserLlmStart = Date.now();
      try {
        response = await chatCompletion(llmConfig, trimmed, openaiTools, signal);
        recordApiCall({
          sessionId: "browser-subagent",
          platform: "internal",
          model: llmConfig.model,
          baseUrl: llmConfig.baseUrl,
          streaming: false,
          caller: "browser",
          promptTokens: response.usage?.promptTokens ?? 0,
          completionTokens: response.usage?.completionTokens ?? 0,
          totalTokens: response.usage?.totalTokens ?? 0,
          toolCalls: response.toolCalls?.length ?? 0,
          iteration: step,
          durationMs: Date.now() - browserLlmStart,
        });
      } catch (e) {
        return {
          success: false,
          needs_human: false,
          summary: signal?.aborted ? "Stopped by user." : `LLM call failed: ${String(e)}`,
          current_url: currentUrl,
          attachments: allAttachments,
        };
      }

      const text = response.content ?? "";
      const toolCalls = response.toolCalls ?? [];

      // Execute tool calls
      const toolResults: Array<{ tc: ToolCall; output: string }> = [];
      for (const tc of toolCalls) {
        if (signal?.aborted) {
          return {
            success: false,
            needs_human: false,
            summary: "Stopped by user.",
            current_url: currentUrl,
            attachments: allAttachments,
          };
        }
        const tool = this.toolRegistry.get(tc.name);
        if (!tool) {
          toolResults.push({ tc, output: `Tool ${tc.name} not found.` });
          continue;
        }
        const result = await tool.execute(tc.arguments);
        if (result.attachments?.length) {
          allAttachments.push(...result.attachments);
        }
        if (!result.success && isBrowserInfraError(result.error)) {
          return {
            success: false,
            needs_human: false,
            summary: `Browser infrastructure is unavailable — the browser sidecar (${this.sidecarUrl}) or its Chromium is not reachable: ${result.error}`,
            current_url: currentUrl,
            attachments: allAttachments,
          };
        }
        toolResults.push({ tc, output: `${result.success ? "OK" : "FAIL"} — ${result.output}${result.error ? ` (${result.error})` : ""}` });
      }

      // Update current URL if navigate happened
      const navCall = toolCalls.find((t) => t.name === "browser_navigate");
      if (navCall) {
        currentUrl = navCall.arguments["url"] as string;
      }

      const doneTool = toolCalls.find((t) => t.name === "browser_done");
      if (doneTool) {
        const needsHuman = doneTool.arguments["needs_human"] === true;
        return {
          success: !needsHuman,
          needs_human: needsHuman,
          summary: String(doneTool.arguments["summary"] ?? text),
          current_url: currentUrl,
          attachments: allAttachments,
        };
      }

      if (toolCalls.length > 0) {
        messages.push({
          role: "assistant",
          content: text,
          tool_calls: toolCalls.map((tc) => ({
            id: tc.id,
            type: "function" as const,
            function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
          })),
        });
        for (const { tc, output } of toolResults) {
          messages.push({ role: "tool", tool_call_id: tc.id, content: output });
        }
      } else {
        messages.push({ role: "assistant", content: text });
        messages.push({ role: "user", content: "Continue." });
      }
    }

    // Out of budget: 30 steps of browsing still hold real findings — salvage them
    // with one last tool-free LLM call instead of discarding everything.
    const findings = await this.summarizeFindings(messages, signal);
    return {
      success: false,
      needs_human: false,
      summary: findings
        ? `Reached maximum number of steps without completing the task. Findings so far: ${findings}`
        : "Reached maximum number of steps without completing the task.",
      current_url: currentUrl,
      attachments: allAttachments,
    };
    } finally {
      await this.client.cleanup().catch(() => undefined);
    }
  }

  private async summarizeFindings(messages: ChatMessage[], signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) return "";
    const llmConfig = resolveOpenAiLlmConfig(this.config.llm);
    const prompt: ChatMessage[] = [
      ...messages,
      {
        role: "user",
        content:
          "You are out of steps and cannot use tools anymore. Summarize concisely everything relevant you actually found or observed so far for the task (facts, names, dates, URLs), and what remained blocked. Plain text only.",
      },
    ];
    const trimmed = trimToContextWindow(prompt, llmConfig.limit?.context, 0);
    const start = Date.now();
    try {
      const response = await chatCompletion(llmConfig, trimmed, undefined, signal);
      recordApiCall({
        sessionId: "browser-subagent",
        platform: "internal",
        model: llmConfig.model,
        baseUrl: llmConfig.baseUrl,
        streaming: false,
        caller: "browser",
        promptTokens: response.usage?.promptTokens ?? 0,
        completionTokens: response.usage?.completionTokens ?? 0,
        totalTokens: response.usage?.totalTokens ?? 0,
        toolCalls: 0,
        iteration: this.maxSteps,
        durationMs: Date.now() - start,
      });
      return (response.content ?? "").trim();
    } catch {
      return "";
    }
  }

  /** Snapshot of the tabs already open in the shared browser, injected into the
   *  system prompt so the subagent reuses them instead of opening duplicates. */
  private async formatOpenTabs(): Promise<string> {
    let tabs: Awaited<ReturnType<BrowserClient["listTabs"]>>;
    try {
      tabs = await this.client.listTabs();
    } catch {
      return "## Open browser tabs\n(could not read the current tabs)";
    }
    if (tabs.length === 0) {
      return "## Open browser tabs\nNone yet — the browser has no open tabs.";
    }
    const lines = tabs.map((t, i) => `[${i}] ${t.title ? `${t.title} — ` : ""}${t.url}`);
    return `## Open browser tabs\nThese are already open in the shared browser. Reuse a relevant one with browser_focus_tab; do not open duplicates or clobber unrelated tabs.\n${lines.join("\n")}`;
  }

  async cleanup(): Promise<void> {
    await this.client.cleanup();
  }
}
