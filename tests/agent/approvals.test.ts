import { test } from "bun:test";
import assert from "node:assert/strict";
import { ToolApprovalManager } from "../../src/agent/approvals.ts";
import type { SessionData } from "../../src/sessions/store.ts";
import type { ToolApprovalRequest } from "../../src/channels/types.ts";

function createSession(): SessionData {
  return {
    id: "test",
    platform: "telegram",
    chatType: "dm",
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    messages: [],
  };
}

function createRequest(toolName: string): ToolApprovalRequest {
  return {
    id: "req-1",
    platform: "telegram",
    chatId: "chat-1",
    userId: "user-1",
    chatType: "dm",
    messageId: "msg-1",
    sessionId: "test",
    toolName,
    args: {},
  };
}

test("non-blacklisted tool returns allow-once", async () => {
  const mgr = new ToolApprovalManager(["bash"]);
  const decision = await mgr.decide({
    session: createSession(),
    request: createRequest("read"),
  });
  assert.equal(decision, "allow-once");
});

test("blacklisted tool with no handler returns deny", async () => {
  const mgr = new ToolApprovalManager(["bash"]);
  const decision = await mgr.decide({
    session: createSession(),
    request: createRequest("bash"),
  });
  assert.equal(decision, "deny");
});

test("blacklisted tool, handler returns allow-once", async () => {
  let called = false;
  const mgr = new ToolApprovalManager(["bash"], async () => {
    called = true;
    return "allow-once";
  });
  const session = createSession();
  const decision = await mgr.decide({
    session,
    request: createRequest("bash"),
  });
  assert.equal(decision, "allow-once");
  assert.equal(called, true);
  assert.equal(session.approvedTools, undefined);
});

test("blacklisted tool, handler returns allow-session updates approvedTools", async () => {
  const mgr = new ToolApprovalManager(["bash"], async () => "allow-session");
  const session = createSession();
  const decision = await mgr.decide({
    session,
    request: createRequest("bash"),
  });
  assert.equal(decision, "allow-session");
  assert.ok(session.approvedTools);
  assert.ok(session.approvedTools.includes("bash"));
});

test("already-approved tool returns allow-session without calling handler", async () => {
  let called = false;
  const mgr = new ToolApprovalManager(["bash"], async () => {
    called = true;
    return "deny";
  });
  const session = createSession();
  session.approvedTools = ["bash"];
  const decision = await mgr.decide({
    session,
    request: createRequest("bash"),
  });
  assert.equal(decision, "allow-session");
  assert.equal(called, false);
});

test("setHandler replaces handler", async () => {
  const mgr = new ToolApprovalManager(["bash"], async () => "deny");
  mgr.setHandler(async () => "allow-once");
  const decision = await mgr.decide({
    session: createSession(),
    request: createRequest("bash"),
  });
  assert.equal(decision, "allow-once");
});

test("multiple blacklisted tools, only matching one triggers", async () => {
  let handlerTool = "";
  const mgr = new ToolApprovalManager(["bash", "write"], async (req) => {
    handlerTool = req.toolName;
    return "allow-once";
  });
  const decision = await mgr.decide({
    session: createSession(),
    request: createRequest("bash"),
  });
  assert.equal(decision, "allow-once");
  assert.equal(handlerTool, "bash");

  const decision2 = await mgr.decide({
    session: createSession(),
    request: createRequest("read"),
  });
  assert.equal(decision2, "allow-once");
});

test("handler returning deny does not modify session", async () => {
  const mgr = new ToolApprovalManager(["bash"], async () => "deny");
  const session = createSession();
  const decision = await mgr.decide({
    session,
    request: createRequest("bash"),
  });
  assert.equal(decision, "deny");
  assert.equal(session.approvedTools, undefined);
});
