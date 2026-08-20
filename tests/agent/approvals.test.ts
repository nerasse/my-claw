import { test } from "bun:test";
import assert from "node:assert/strict";
import { ToolApprovalManager } from "../../src/agent/approvals.ts";
import type { SessionData } from "../../src/sessions/store.ts";
import type { ApprovalDecision, ToolApprovalRequest } from "../../src/channels/types.ts";

function createSession(): SessionData {
  return {
    id: "test",
    platform: "my-claw-app",
    chatType: "dm",
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    messages: [],
  };
}

function createRequest(toolName: string): ToolApprovalRequest {
  return {
    id: "req-1",
    platform: "my-claw-app",
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

test("memory is not force-approved: with an empty blacklist it runs freely", async () => {
  let handlerCalled = false;
  const mgr = new ToolApprovalManager([], async () => {
    handlerCalled = true;
    return "deny";
  });
  const decision = await mgr.decide({
    session: createSession(),
    request: createRequest("memory"),
  });
  assert.equal(decision, "allow-once");
  assert.equal(handlerCalled, false, "approval is strictly blacklist-driven");
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
  const mgr = new ToolApprovalManager(["write"], async () => "allow-session");
  const session = createSession();
  const decision = await mgr.decide({
    session,
    request: createRequest("write"),
  });
  assert.equal(decision, "allow-session");
  assert.ok(session.approvedTools);
  assert.ok(session.approvedTools.includes("write"));
});

test("already-approved tool returns allow-session without calling handler", async () => {
  let called = false;
  const mgr = new ToolApprovalManager(["write"], async () => {
    called = true;
    return "deny";
  });
  const session = createSession();
  session.approvedTools = ["write"];
  const decision = await mgr.decide({
    session,
    request: createRequest("write"),
  });
  assert.equal(decision, "allow-session");
  assert.equal(called, false);
});

test("bash is always per-invocation: skips session cache, does not store approval", async () => {
  let callCount = 0;
  const mgr = new ToolApprovalManager(["bash"], async () => {
    callCount++;
    return "allow-session";
  });
  const session = createSession();
  session.approvedTools = ["bash"];

  const d1 = await mgr.decide({ session, request: createRequest("bash") });
  assert.equal(d1, "allow-session");
  assert.equal(callCount, 1);

  const d2 = await mgr.decide({ session, request: createRequest("bash") });
  assert.equal(d2, "allow-session");
  assert.equal(callCount, 2);
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

test("concurrent prompts for the same tool are coalesced into one", async () => {
  let callCount = 0;
  let release!: (d: ApprovalDecision) => void;
  const gate = new Promise<ApprovalDecision>((r) => {
    release = r;
  });
  const mgr = new ToolApprovalManager(["spawn"], async () => {
    callCount++;
    return gate;
  });
  const session = createSession();
  const p1 = mgr.decide({ session, request: createRequest("spawn") });
  const p2 = mgr.decide({ session, request: createRequest("spawn") });
  const p3 = mgr.decide({ session, request: createRequest("spawn") });
  release("allow-once");
  const [d1, d2, d3] = await Promise.all([p1, p2, p3]);
  assert.equal(callCount, 1, "handler prompted only once for the parallel batch");
  assert.equal(d1, "allow-once");
  assert.equal(d2, "allow-once");
  assert.equal(d3, "allow-once");
});

test("coalesced allow-session updates approvedTools exactly once", async () => {
  let release!: (d: ApprovalDecision) => void;
  const gate = new Promise<ApprovalDecision>((r) => {
    release = r;
  });
  const mgr = new ToolApprovalManager(["spawn"], async () => gate);
  const session = createSession();
  const p1 = mgr.decide({ session, request: createRequest("spawn") });
  const p2 = mgr.decide({ session, request: createRequest("spawn") });
  release("allow-session");
  await Promise.all([p1, p2]);
  assert.deepEqual(session.approvedTools, ["spawn"]);
});

test("after a coalesced batch resolves, a later prompt asks again", async () => {
  let callCount = 0;
  const mgr = new ToolApprovalManager(["spawn"], async () => {
    callCount++;
    return "allow-once";
  });
  const session = createSession();
  await mgr.decide({ session, request: createRequest("spawn") });
  await mgr.decide({ session, request: createRequest("spawn") });
  assert.equal(callCount, 2, "sequential (non-concurrent) prompts are not coalesced");
});

test("bash concurrent prompts are NOT coalesced (per-invocation)", async () => {
  let callCount = 0;
  let release!: (d: ApprovalDecision) => void;
  const gate = new Promise<ApprovalDecision>((r) => {
    release = r;
  });
  const mgr = new ToolApprovalManager(["bash"], async () => {
    callCount++;
    return gate;
  });
  const session = createSession();
  const p1 = mgr.decide({ session, request: createRequest("bash") });
  const p2 = mgr.decide({ session, request: createRequest("bash") });
  const p3 = mgr.decide({ session, request: createRequest("bash") });
  release("allow-once");
  await Promise.all([p1, p2, p3]);
  assert.equal(callCount, 3, "each bash command is reviewed individually");
});
