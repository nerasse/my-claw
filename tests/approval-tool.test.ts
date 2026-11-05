import { describe, test, expect, afterEach } from "bun:test";
import { createApprovalTool } from "../src/tools/approval.ts";
import { setApprovalSurface } from "../src/approvals/ask.ts";
import type { ToolApprovalRequest } from "../src/channels/types.ts";
import type { UnifiedMessage } from "../src/channels/types.ts";

const message = {
  id: "m1",
  platform: "my-claw-app",
  userId: "owner",
  chatId: "owner",
  chatType: "dm",
  text: "go",
  attachments: [],
  isForwarded: false,
  threadId: "projet",
  raw: {},
} as UnifiedMessage;

function run(args: Record<string, unknown>) {
  return createApprovalTool().execute({ __message: message, __sessionId: "s1", __toolCallId: "t-call_1", ...args });
}

afterEach(() => setApprovalSurface(undefined));

describe("approval tool", () => {
  test("request waits with no timer and carries the sentence, the call and the parent thread", async () => {
    const asked: ToolApprovalRequest[] = [];
    setApprovalSurface({
      ask: async (request) => {
        asked.push(request);
        return "allow-once";
      },
      pending: () => [],
    });

    const result = await run({ action: "request", what: "check the disks on archy", command: "df -h" });
    expect(result.success).toBe(true);
    expect(result.output).toContain("approved");
    expect(asked).toHaveLength(1);
    expect(asked[0]?.waitForever).toBe(true);
    expect(asked[0]?.headline).toBe("check the disks on archy");
    expect(asked[0]?.toolName).toBe("bash");
    expect(asked[0]?.args).toEqual({ command: "df -h" });
    expect(asked[0]?.threadId).toBe("projet");
    expect(asked[0]?.replyToId).toBe("t-call_1");
  });

  test("the three answers come back as the three outcomes the model can branch on", async () => {
    for (const [decision, expected] of [["allow-always", "approved-always"], ["deny", "denied"]] as const) {
      setApprovalSurface({ ask: async () => decision, pending: () => [] });
      const result = await run({ action: "request", what: "do it" });
      expect(result.output).toContain(expected);
    }
  });

  test("list reports what is waiting, with the machine and the wait", async () => {
    setApprovalSurface({
      ask: async () => "deny",
      pending: () => [
        {
          id: "ap_1",
          toolName: "bash",
          args: { command: "rm -rf /tmp/x" },
          origin: "archy",
          since: "2026-11-05T11:00:00.000Z",
          waitForever: true,
        },
      ],
    });
    const result = await run({ action: "list" });
    expect(result.output).toContain("1 waiting");
    expect(result.output).toContain("archy");
    expect(result.output).toContain("rm -rf /tmp/x");
    expect(result.output).toContain("no timeout");
  });

  test("without a surface, and without a sentence, the tool refuses instead of hanging", async () => {
    const noSurface = await run({ action: "request", what: "do it" });
    expect(noSurface.success).toBe(false);

    setApprovalSurface({ ask: async () => "allow-once", pending: () => [] });
    const noWhat = await run({ action: "request" });
    expect(noWhat.success).toBe(false);
    expect(noWhat.error).toContain("what is required");
  });
});
