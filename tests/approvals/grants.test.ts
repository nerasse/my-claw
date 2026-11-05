import { describe, test, expect } from "bun:test";
import { canonicalArgs, grantOf, originKey } from "../../src/approvals/grants.ts";
import { ToolApprovalManager } from "../../src/agent/approvals.ts";
import type { SessionData } from "../../src/sessions/store.ts";
import type { ToolApprovalRequest } from "../../src/channels/types.ts";
import type { ApprovalGrantConfig } from "../../src/core/config.ts";
import { recordApproval, listApprovals } from "../../src/approvals/store.ts";

const session = { id: "s1", approvedTools: [] } as unknown as SessionData;

function request(args: Record<string, unknown>, origin?: ToolApprovalRequest["origin"]): ToolApprovalRequest {
  return {
    id: "call-1",
    platform: "my-claw-app",
    chatId: "owner",
    userId: "owner",
    chatType: "dm",
    messageId: "m1",
    sessionId: "s1",
    toolName: "bash",
    args,
    threadId: "t1",
    ...(origin ? { origin } : {}),
  };
}

function grants(...list: ApprovalGrantConfig[]): () => readonly ApprovalGrantConfig[] {
  return () => list;
}

describe("grant keys", () => {
  test("arguments canonicalise regardless of key order, at every depth", () => {
    expect(canonicalArgs({ path: "/a", mode: "r" })).toBe(canonicalArgs({ mode: "r", path: "/a" }));
    expect(canonicalArgs({ a: { y: 1, x: [2, { b: 1, a: 2 }] } })).toBe('{"a":{"x":[2,{"a":2,"b":1}],"y":1}}');
  });

  test("a grant matches one tool, one machine and one exact call, and nothing wider", () => {
    const args = { command: "df -h" };
    const list: ApprovalGrantConfig[] = [{ tool: "bash", origin: "local", args: canonicalArgs(args) }];
    expect(grantOf(list, { toolName: "bash", args })).toBeDefined();
    // A different command is a different decision.
    expect(grantOf(list, { toolName: "bash", args: { command: "rm -rf /" } })).toBeUndefined();
    // Another machine never inherits it.
    expect(grantOf(list, { toolName: "bash", args, origin: { kind: "node", nodeId: "node-1" } })).toBeUndefined();
    // Another tool never inherits it either.
    expect(grantOf(list, { toolName: "read", args })).toBeUndefined();
  });

  test("the origin key is the machine, local included", () => {
    expect(originKey(undefined)).toBe("local");
    expect(originKey({ kind: "node", nodeId: "node-1" })).toBe("node-1");
  });
});

describe("ToolApprovalManager with grants", () => {
  test("an exact granted call runs without asking, and is journalled as such", async () => {
    let asked = 0;
    const manager = new ToolApprovalManager(
      ["bash"],
      async () => {
        asked += 1;
        return "deny";
      },
      grants({ tool: "bash", origin: "local", args: canonicalArgs({ command: "df -h" }) }),
    );

    const decision = await manager.decide({ session, request: request({ command: "df -h" }) });
    expect(decision).toBe("allow-once");
    expect(asked).toBe(0);

    const rows = listApprovals({ owner: "owner", limit: 5 });
    expect(rows[0]?.outcome).toBe("allow-always");
    expect(rows[0]?.auto).toBe(true);
  });

  test("a call the grant does not cover still asks", async () => {
    let asked = 0;
    const manager = new ToolApprovalManager(
      ["bash"],
      async () => {
        asked += 1;
        return "deny";
      },
      grants({ tool: "bash", origin: "local", args: canonicalArgs({ command: "df -h" }) }),
    );
    expect(await manager.decide({ session, request: request({ command: "uptime" }) })).toBe("deny");
    expect(asked).toBe(1);
  });

  test("a node's tool without a grant asks even when the same call is granted here", async () => {
    let asked = 0;
    const manager = new ToolApprovalManager(
      [],
      async () => {
        asked += 1;
        return "allow-once";
      },
      grants({ tool: "bash", origin: "local", args: canonicalArgs({ command: "df -h" }) }),
    );
    const decision = await manager.decide({
      confirm: true,
      session,
      request: request({ command: "df -h" }, { kind: "node", nodeId: "node-1" }),
    });
    expect(decision).toBe("allow-once");
    expect(asked).toBe(1);
  });
});

describe("approvals journal migration", () => {
  test("a database written before standing grants accepts allow-always", () => {
    // The first read builds (or migrates) the schema; the write proves the CHECK accepts it.
    recordApproval({
      id: "grant-1",
      owner: "owner",
      threadId: "t1",
      sessionId: "s1",
      toolName: "bash",
      args: "{}",
      outcome: "allow-always",
      requestedAt: new Date().toISOString(),
      decidedAt: new Date().toISOString(),
      durationMs: 1,
      auto: false,
    });
    expect(listApprovals({ owner: "owner", limit: 5 }).some((row) => row.id === "grant-1")).toBe(true);
  });
});
