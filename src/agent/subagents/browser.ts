import type { MyClawConfig } from "../../core/config.ts";
import { recordApiCall } from "../../analytics/usage-db.ts";
import type { Attachment } from "../../channels/types.ts";
import { chatCompletion, type ChatMessage, type LlmResponse, type ToolCall } from "../../llm/provider.ts";
import { resolveLlmConfig } from "../../llm/resolver.ts";
import { toOpenAiToolDefinitions } from "../../llm/openai-format.ts";
import { BrowserPool } from "../../browser/pool.ts";
import { BrowserService } from "../../browser/service.ts";
import { ToolRegistry } from "../../tools/registry.ts";
import {
  createBrowserNavigateTool,
  createBrowserSnapshotTool,
  createBrowserClickTool,
  createBrowserTypeTool,
  createBrowserScreenshotTool,
  createBrowserListTabsTool,
  createBrowserFocusTabTool,
  createBrowserCloseTabTool,
} from "../../tools/browser.ts";
import { loadAllPromptFiles } from "../prompt/loader.ts";
import { CORE_PROMPT } from "../prompt/core-prompts.ts";
import { scanForInjection } from "../prompt/anti-injection.ts";

export interface BrowserSubagentResult {
  success: boolean;
  summary?: string;
  needs_human?: boolean;
  hint?: string;
  current_url?: string;
  attachments?: Attachment[];
}

const DEFAULT_MAX_STEPS = 30;

const HUMAN_BLOCKERS = [
  "captcha", "recaptcha", "verify", "human verification",
  "i'm not a robot", "login", "sign in", "password",
  "2fa", "two-factor", "authentication code", "otp",
];

export function detectHumanBlocker(text: string): boolean {
  const lower = text.toLowerCase();
  return HUMAN_BLOCKERS.some((word) => lower.includes(word));
}

const BROWSER_PROMPT = `You are a web browsing assistant. Your job is to complete tasks on websites using the available browser tools.

Available tools:
- browser_navigate(url): Open a URL in a new tab. Always call this first.
- browser_snapshot(): Get the page accessibility tree with ref numbers. ALWAYS call this after every navigate, click, or type to see the new state.
- browser_click(ref): Click an element by its ref number.
- browser_type(ref, text): Type text into a field by its ref number.
- browser_screenshot(full_page?, labels?): Capture a screenshot. Use when stuck or to show the user the page. Set labels=true to overlay ref numbers on elements.
- browser_list_tabs(): List all open tabs with their index and URL.
- browser_focus_tab(index): Switch to a different tab by its index (from browser_list_tabs).
- browser_close_tab(index): Close a tab by its index.
- browser_done(summary): Call this tool when the task is complete. Provide a summary.

Rules:
1. After EVERY action, call browser_snapshot to verify.
2. Use only the ref numbers from the snapshot for click and type.
3. If you see "captcha", "verify", "login", "2FA", "password", or similar, STOP and say you need human help.
4. If stuck for 3 steps, STOP and ask for help.
5. When done, call browser_done with a summary of what was accomplished.
6. Use browser_screenshot to capture visual evidence of results — these screenshots are delivered to the user.`;

async function buildBrowserSystemPrompt(): Promise<string> {
  const layers: string[] = [];

  layers.push(CORE_PROMPT);

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

export class BrowserSubagent {
  private pool: BrowserPool;
  private service: BrowserService;
  private toolRegistry: ToolRegistry;
  private maxSteps: number;

  constructor(
    private config: MyClawConfig,
    private cdpUrl: string,
  ) {
    this.maxSteps = config.browser?.maxSteps ?? DEFAULT_MAX_STEPS;
    this.pool = new BrowserPool(cdpUrl, config.browser?.idleTimeoutMs);
    this.service = new BrowserService(this.pool, config.browser?.viewport);
    this.toolRegistry = new ToolRegistry();
    this.toolRegistry.register(createBrowserNavigateTool(this.service));
    this.toolRegistry.register(createBrowserSnapshotTool(this.service));
    this.toolRegistry.register(createBrowserClickTool(this.service));
    this.toolRegistry.register(createBrowserTypeTool(this.service));
    this.toolRegistry.register(createBrowserScreenshotTool(this.service));
    this.toolRegistry.register(createBrowserListTabsTool(this.service));
    this.toolRegistry.register(createBrowserFocusTabTool(this.service));
    this.toolRegistry.register(createBrowserCloseTabTool(this.service));
    this.toolRegistry.register({
      name: "browser_done",
      description: "Signal that the task is complete. Provide a summary of what was accomplished.",
      parameters: { type: "object", properties: { summary: { type: "string", description: "Summary of what was done" } }, required: ["summary"] },
      async execute(args) { return { success: true, output: String(args["summary"] ?? "done") }; },
    });
  }

  async run(task: string, startUrl?: string): Promise<BrowserSubagentResult> {
    const messages: ChatMessage[] = [
      { role: "system", content: await buildBrowserSystemPrompt() },
      { role: "user", content: `Task: ${task}${startUrl ? `\nStart URL: ${startUrl}` : ""}` },
    ];

    let currentUrl = startUrl ?? "";
    const allAttachments: Attachment[] = [];

    try {
    for (let step = 0; step < this.maxSteps; step++) {
      const openaiTools = toOpenAiToolDefinitions(this.toolRegistry.getForAgent("general"));

      let response: LlmResponse;
      const llmConfig = resolveLlmConfig(this.config.llm);
      const browserLlmStart = Date.now();
      try {
        response = await chatCompletion(llmConfig, messages, openaiTools);
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
          needs_human: true,
          hint: `LLM call failed: ${String(e)}`,
          current_url: currentUrl,
          attachments: allAttachments,
        };
      }

      const text = response.content ?? "";
      const toolCalls = response.toolCalls ?? [];

      // Execute tool calls
      const toolResults: Array<{ tc: ToolCall; output: string }> = [];
      for (const tc of toolCalls) {
        const tool = this.toolRegistry.get(tc.name);
        if (!tool) {
          toolResults.push({ tc, output: `Tool ${tc.name} not found.` });
          continue;
        }
        const result = await tool.execute(tc.arguments);
        if (result.attachments?.length) {
          allAttachments.push(...result.attachments);
        }
        toolResults.push({ tc, output: `${result.success ? "OK" : "FAIL"} — ${result.output}${result.error ? ` (${result.error})` : ""}` });
      }

      // Update current URL if navigate happened
      const navCall = toolCalls.find((t) => t.name === "browser_navigate");
      if (navCall) {
        currentUrl = navCall.arguments["url"] as string;
      }

      const combinedText = text + " " + toolResults.map((r) => r.output).join(" ");

      if (detectHumanBlocker(combinedText)) {
        return {
          success: false,
          needs_human: true,
          hint: "Detected potential human verification barrier (CAPTCHA, login, or 2FA).",
          current_url: currentUrl,
          attachments: allAttachments,
        };
      }

      const doneTool = toolCalls.find((t) => t.name === "browser_done");
      if (doneTool) {
        return {
          success: true,
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

    return {
      success: false,
      needs_human: true,
      hint: "Reached maximum number of steps without completing the task.",
      current_url: currentUrl,
      attachments: allAttachments,
    };
    } finally {
      await this.service.closeAllPages().catch(() => undefined);
    }
  }

  async cleanup(): Promise<void> {
    await this.service.cleanup();
  }
}
