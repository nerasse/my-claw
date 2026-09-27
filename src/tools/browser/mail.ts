import type { MyClawConfig } from "../../core/config.ts";
import { DEFAULT_SITE_GROUPS, findVerification, type MailSource } from "../../mail/verification.ts";
import { log } from "../../utils/logger.ts";
import { type Tool, type ToolResult } from "../types.ts";
import type { BrowserWindows } from "./windows.ts";

const DEFAULT_SINCE_MINUTES = 15;
const MAX_SINCE_MINUTES = 60;

/**
 * The browser agent's one window on the mailbox: the code or the verification link the page it is
 * on just sent -- docs/mail-verification.md. The site is read from the page, never from an
 * argument, so a page cannot point the tool at another sender; and nothing of the mail but the code
 * or the link comes back.
 */
export function createBrowserMailVerificationTool(
  windows: BrowserWindows,
  source: MailSource & { configured(): Promise<boolean> },
  config: MyClawConfig,
): Tool {
  return {
    name: "browser_mail_verification",
    description: "Read the verification code or confirmation link the site of your current page just e-mailed to the owner. Returns only the code or the link, the sender's domain and the time it arrived: never the mail itself. Only mails from the page's own site count, so call it on the page that asks for the code. If the mail has not arrived yet, wait a little (browser_wait_for) and call it again.",
    parameters: {
      type: "object",
      properties: {
        since_minutes: { type: "number", description: `How far back to look, in minutes (default ${DEFAULT_SINCE_MINUTES}, at most ${MAX_SINCE_MINUTES}).` },
      },
    },
    async execute(args): Promise<ToolResult> {
      if (config.browser?.mailVerification?.enabled === false) {
        return { success: false, output: "", error: "Reading verification mails is turned off (browser.mailVerification.enabled = false). Hand over to a human, or keep the window for the conversation that sent you." };
      }
      if (!(await source.configured())) {
        return { success: false, output: "", error: "No mailbox is set up for verification codes on this machine. Keep the window (browser_done keep_window=true) and say the code is needed." };
      }
      const raw = typeof args["since_minutes"] === "number" ? args["since_minutes"] : DEFAULT_SINCE_MINUTES;
      const minutes = Math.min(MAX_SINCE_MINUTES, Math.max(1, Math.round(raw)));
      const pageUrl = await windows.currentUrl(args);
      const groups = [...DEFAULT_SITE_GROUPS, ...(config.browser?.mailVerification?.sites ?? [])];
      let host = "";
      try {
        host = new URL(pageUrl).hostname;
      } catch {
        // Reported by findVerification below.
      }
      try {
        const { result, reason } = await findVerification(source, pageUrl, Date.now() - minutes * 60_000, { groups });
        // Audited like the low-level tools: which page asked, which site answered, whether anything
        // was found. Never the code or the link.
        void log("info", "browser mail verification", {
          sessionId: typeof args["__sessionId"] === "string" ? args["__sessionId"] : undefined,
          pageHost: host,
          sender: result?.sender,
          found: result ? (result.code ? "code" : "link") : "none",
        });
        if (!result) return { success: false, output: "", error: reason ?? "Nothing found." };
        const at = new Date(result.receivedAt).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
        const lines = [
          ...(result.code ? [`Code: ${result.code}`] : []),
          ...(result.link ? [`Link: ${result.link}`] : []),
          `From ${result.sender}, received at ${at}.`,
        ];
        return { success: true, output: lines.join("\n") };
      } catch (err) {
        return { success: false, output: "", error: `The mailbox could not be read: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  };
}
