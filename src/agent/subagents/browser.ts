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
  createBrowserHoverTool,
  createBrowserDragTool,
  createBrowserClickAtTool,
  createBrowserWaitForTool,
  createBrowserHandleDialogTool,
  createBrowserDownloadTool,
  createBrowserPdfTool,
  createBrowserEvalTool,
  createBrowserCdpTool,
  type BrowserLowLevelOptions,
  createBrowserScreenshotTool,
  createBrowserListTabsTool,
  createBrowserFocusTabTool,
  createBrowserCloseTabTool,
  createBrowserPageState,
} from "../../tools/browser/index.ts";
import { loadAllPromptFiles, loadCorePrompt } from "../prompt/loader.ts";
import { normalizeUntrusted } from "../prompt/normalize-untrusted.ts";

export interface BrowserSubagentResult {
  success: boolean;
  summary: string;
  needs_human: boolean;
  current_url?: string;
  attachments?: Attachment[];
}

// The escalation ladder deliberately spends several steps per obstacle instead of handing
// off, so the budget has to absorb a few of those on top of the task's own actions.
const DEFAULT_MAX_STEPS = 60;

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
- browser_hover(ref): Hover an element — menus that only open on hover, tooltips.
- browser_drag(from_ref, to_ref): Drag one element onto another (sliders, reorderable lists, drop zones).
- browser_click_at(x, y): Click by POSITION, given as fractions of the viewport (0.5, 0.5 is the centre). Screenshot first, estimate the fractions from it. This reaches anything with no ref at all: canvas, WebGL, maps, exotic overlays.
- browser_wait_for(text?, ref?, timeout_ms?): Wait for text to appear, for a ref to become visible, or a fixed delay. Use this instead of re-snapshotting in a loop.
- browser_handle_dialog(accept, prompt_text?): Choose how the NEXT native dialog is answered. Call it BEFORE the click that triggers it; otherwise dialogs are auto-accepted.
- browser_download(timeout_ms?): Save a file the page downloads and get its local path. Click the link first, then call this.
- browser_pdf(path?): Save the current page as a PDF (invoice, ticket, confirmation) and get the path.
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
   e. browser_wait_for — the element may simply not have rendered yet
   f. browser_scroll to bring the element into view, then retry the action
   g. browser_hover — the target may only exist while a parent menu is open
   h. browser_screenshot(labels=true), then browser_click_at with fractions read off the image
   If the whole ladder fails, finish with browser_done and needs_human=FALSE, stating precisely which rungs you tried — that is a tooling gap to fix, not a reason to summon the user.
7. When the task is complete, call browser_done with a summary (needs_human defaults to false). Include everything useful you found — the summary is all the caller gets.
8. Use browser_screenshot to capture visual evidence of results — these screenshots are delivered to the user. Only screenshot a page that is fully loaded and free of overlays.`;

// Documented only when actually registered: advertising a disabled tool costs a wasted step
// and an error the agent then has to reason about.
const LOW_LEVEL_PROMPT = `Low-level tools (enabled in this deployment, use only when the ladder in rule 6 is exhausted):
- browser_eval(js): Run JavaScript in the page. Pass a statement body and use \`return\`.
- browser_cdp(method, params): Raw Chrome DevTools Protocol on this page, restricted to an allowlist.
Prefer the normal tools: these two bypass what the page shows you, so a mistake is harder to notice.`;

async function buildBrowserSystemPrompt(
  extraLayers: string[] = [],
  workspaceDir?: string,
  defaultWorkspaceDir?: string,
): Promise<string> {
  const layers: string[] = [];

  layers.push(await loadCorePrompt(workspaceDir, defaultWorkspaceDir));

  const files = await loadAllPromptFiles(workspaceDir, defaultWorkspaceDir);
  for (const name of ["SOUL.md", "USER.md"] as const) {
    const content = files[name];
    if (content) {
      const safe = normalizeUntrusted(content, name);
      if (safe) layers.push(safe);
    }
  }

  layers.push(BROWSER_PROMPT);
  layers.push(...extraLayers);
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
  private extraPromptLayers: string[] = [];

  constructor(
    private config: MyClawConfig,
    private sidecarUrl: string,
    // Session that asked for this browser task. The browser has no session of its own, so without
    // it these calls land in a global bucket and no conversation ever shows what it delegated.
    // Passed explicitly rather than derived from the run's abort signal, because a sub-agent shares
    // the root signal and would attribute its browsing to the top-level chat instead of itself.
    private callerSessionId?: string,
    // Workspace of the run that spawned this sub-agent: its prompt files and tool roots follow
    // the parent, not the process-wide default.
    private workspaceDir?: string,
  ) {
    this.maxSteps = config.browser?.maxSteps ?? DEFAULT_MAX_STEPS;
    this.client = new BrowserClient(sidecarUrl, config.browser?.viewport, config.browser?.timeoutsMs);
    this.toolRegistry = new ToolRegistry();
    const pageState = createBrowserPageState();
    const lowLevel: BrowserLowLevelOptions = {
      config: config.browser,
      workspaceDir: this.workspaceDir ?? config.workspace,
    };
    this.toolRegistry.register(createBrowserNavigateTool(this.client, pageState));
    this.toolRegistry.register(createBrowserSnapshotTool(this.client, pageState));
    this.toolRegistry.register(createBrowserClickTool(this.client, pageState));
    this.toolRegistry.register(createBrowserTypeTool(this.client, pageState));
    this.toolRegistry.register(createBrowserSelectOptionTool(this.client, pageState));
    this.toolRegistry.register(createBrowserUploadFileTool(this.client, pageState, config.workspace));
    this.toolRegistry.register(createBrowserPressKeyTool(this.client, pageState));
    this.toolRegistry.register(createBrowserScrollTool(this.client, pageState));
    this.toolRegistry.register(createBrowserHoverTool(this.client, pageState));
    this.toolRegistry.register(createBrowserDragTool(this.client, pageState));
    this.toolRegistry.register(createBrowserClickAtTool(this.client, pageState));
    this.toolRegistry.register(createBrowserWaitForTool(this.client, pageState));
    this.toolRegistry.register(createBrowserHandleDialogTool(this.client, pageState));
    this.toolRegistry.register(createBrowserDownloadTool(this.client, pageState, lowLevel));
    this.toolRegistry.register(createBrowserPdfTool(this.client, pageState, lowLevel));
    if (config.browser?.allowEval) {
      this.toolRegistry.register(createBrowserEvalTool(this.client, pageState, lowLevel));
    }
    if (config.browser?.allowCdp) {
      this.toolRegistry.register(createBrowserCdpTool(this.client, pageState, lowLevel));
    }
    if (config.browser?.allowEval || config.browser?.allowCdp) {
      this.extraPromptLayers.push(LOW_LEVEL_PROMPT);
    }
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
    const systemPrompt = `${await buildBrowserSystemPrompt(this.extraPromptLayers, this.workspaceDir, this.config.workspace)}\n\n${await this.formatOpenTabs()}`;
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

      const available = this.toolRegistry.getForAgent("general", this.config.tools?.disabled);
      const openaiTools = toOpenAiToolDefinitions(available);

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
          parentSessionId: this.callerSessionId,
          platform: "internal",
          model: llmConfig.model,
          baseUrl: llmConfig.baseUrl,
          streaming: false,
          caller: "browser",
          promptTokens: response.usage?.promptTokens ?? 0,
          completionTokens: response.usage?.completionTokens ?? 0,
          totalTokens: response.usage?.totalTokens ?? 0,
          cacheReadTokens: response.usage?.cacheReadTokens ?? 0,
          cacheWriteTokens: response.usage?.cacheWriteTokens ?? 0,
          toolCalls: response.toolCalls?.length ?? 0,
          iteration: step,
          durationMs: Date.now() - browserLlmStart,
          proxyCostUsd: response.proxyCostUsd,
          upstreamApiBase: response.upstreamApiBase,
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
        // Same set the model was offered, not the whole registry: a global lookup let a hallucinated
        // name run a tool that `tools.disabled` had removed.
        const tool = available.find((t) => t.name === tc.name);
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
        parentSessionId: this.callerSessionId,
        platform: "internal",
        model: llmConfig.model,
        baseUrl: llmConfig.baseUrl,
        streaming: false,
        caller: "browser",
        promptTokens: response.usage?.promptTokens ?? 0,
        completionTokens: response.usage?.completionTokens ?? 0,
        totalTokens: response.usage?.totalTokens ?? 0,
        cacheReadTokens: response.usage?.cacheReadTokens ?? 0,
        cacheWriteTokens: response.usage?.cacheWriteTokens ?? 0,
        toolCalls: 0,
        iteration: this.maxSteps,
        durationMs: Date.now() - start,
        proxyCostUsd: response.proxyCostUsd,
        upstreamApiBase: response.upstreamApiBase,
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
