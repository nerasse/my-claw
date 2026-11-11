import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { rm } from "node:fs/promises";
import { createApprovalTool } from "../src/tools/approval.ts";
import { setApprovalSurface } from "../src/approvals/ask.ts";
import { mintNode, nodesFilePath, resetNodesStore, setNodeAccess } from "../src/nodes/store.ts";
import type { MyClawConfig } from "../src/core/config.ts";
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

function config(patch: Partial<MyClawConfig> = {}): MyClawConfig {
  return { workspace: "/tmp/ws", llm: { providers: {} }, blacklist: [], ...patch } as MyClawConfig;
}

function run(args: Record<string, unknown>, cfg?: MyClawConfig) {
  return createApprovalTool(cfg).execute({ __message: message, __sessionId: "s1", __toolCallId: "t-call_1", ...args });
}

async function pair(name: string, asks = true): Promise<string> {
  const minted = await mintNode({ name, facts: { os: "linux", arch: "x64", hostname: name, user: "neras", mode: "user", version: "0.1.0", tools: [] } });
  if (!minted.ok) throw new Error(minted.error);
  const nodeId = minted.minted.record.nodeId;
  if (!asks) await setNodeAccess(nodeId, { approval: false });
  return nodeId;
}

beforeEach(async () => {
  await resetNodesStore();
  await rm(nodesFilePath(), { force: true });
});

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

describe("approval tool: grants", () => {
  test("a quiet install says nothing asks, and no grant is invented", async () => {
    const result = await run({ action: "grants" }, config());
    expect(result.success).toBe(true);
    expect(result.output).toContain("local -- nothing asks | no grants");
    expect(result.output).not.toContain("asks before");
  });

  test("the global blacklist names what still asks on this machine", async () => {
    const result = await run({ action: "grants", origin: "local" }, config({ blacklist: ["bash", "memory"] }));
    expect(result.output).toContain("local -- asks before: bash, memory");
  });

  test("a freshly paired node asks before every call, and says so with its id and live state", async () => {
    const nodeId = await pair("archy");
    const result = await run({ action: "grants", origin: "archy" }, config());
    expect(result.output).toContain(`archy (${nodeId}) [offline] -- asks before every call`);
  });

  test("a node the owner let run unasked says so", async () => {
    const nodeId = await pair("archy", false);
    const result = await run({ action: "grants", origin: "archy" }, config());
    expect(result.output).toContain(`archy (${nodeId}) [offline] -- nothing asks`);
  });

  test("grants ride the machine they were given on, and only that one", async () => {
    const nodeId = await pair("archy");
    const cfg = config({
      tools: {
        alwaysAllow: [
          { tool: "bash", origin: "local", args: '{"command":"df -h"}' },
          { tool: "bash", origin: nodeId, args: '{"command":"systemctl --user status my-claw.service"}' },
        ],
      },
    });
    const all = await run({ action: "grants" }, cfg);
    expect(all.output).toContain('local -- nothing asks | 1 grant\n  bash {"command":"df -h"}');
    expect(all.output).toContain('bash {"command":"systemctl --user status my-claw.service"}');

    const local = await run({ action: "grants", origin: "local" }, cfg);
    expect(local.output).toContain('bash {"command":"df -h"}');
    expect(local.output).not.toContain("systemctl");

    const node = await run({ action: "grants", origin: nodeId }, cfg);
    expect(node.output).toContain("systemctl");
    expect(node.output).not.toContain("df -h");
  });

  test("the display name works without a lookup, and an unknown machine lists the known ones", async () => {
    const nodeId = await pair("archy");
    const byName = await run({ action: "grants", origin: "ARCHY" }, config());
    expect(byName.success).toBe(true);
    expect(byName.output).toContain(nodeId);

    const unknown = await run({ action: "grants", origin: "nowhere" }, config());
    expect(unknown.success).toBe(false);
    expect(unknown.error).toContain("local");
    expect(unknown.error).toContain("archy");
  });

  test("a revoked machine keeps its grants, shown inert rather than available", async () => {
    const cfg = config({
      tools: { alwaysAllow: [{ tool: "read", origin: "node-gone", args: '{"path":"/etc/hosts"}' }] },
    });
    const result = await run({ action: "grants" }, cfg);
    expect(result.output).toContain("node-gone [not paired] -- nothing runs here");
    expect(result.output).toContain('read {"path":"/etc/hosts"} (inert)');
  });

  test("a long call stays on one line and says where the full one lives", async () => {
    const long = JSON.stringify({ command: `rg ${"x".repeat(400)}` });
    const cfg = config({ tools: { alwaysAllow: [{ tool: "bash", origin: "local", args: long }] } });
    const result = await run({ action: "grants", origin: "local" }, cfg);
    const grantLine = result.output.split("\n").find((line) => line.includes("bash {"));
    expect(grantLine).toContain("truncated");
    expect(grantLine).toContain("tools.alwaysAllow");
    expect(result.output.split("\n").filter((line) => line.includes("bash {")).length).toBe(1);
  });

  test("the schema offers no way to write a grant", () => {
    const tool = createApprovalTool(config());
    const props = tool.parameters["properties"] as Record<string, { enum?: string[] }>;
    expect(props["action"]?.enum).toEqual(["request", "list", "grants"]);
    expect(Object.keys(props).sort()).toEqual(["action", "args", "command", "origin", "tool", "what"]);
  });
});
