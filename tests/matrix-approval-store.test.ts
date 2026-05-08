import test from "node:test";
import assert from "node:assert/strict";
import { createMatrixApprovalStore } from "../src/channels/matrix/approval-store.ts";
import type { ToolApprovalRequest } from "../src/channels/types.ts";

function createRequest(id: string): ToolApprovalRequest {
  return {
    id,
    platform: "matrix",
    chatId: "!room:test",
    userId: "@u1:example.org",
    chatType: "group",
    messageId: "$evt1",
    sessionId: "matrix/group/!room:test",
    toolName: "bash",
    args: { command: "pwd" },
  };
}

test("matrix approval store resolves pending requests", async () => {
  const store = createMatrixApprovalStore(100);
  const request = createRequest("apr-1");
  const decisionPromise = store.request(request);

  const resolved = store.resolve(request.id, "allow-session");
  assert.deepEqual(resolved, { request, expired: false });
  assert.equal(await decisionPromise, "allow-session");
});

test("matrix approval store cancels pending requests", async () => {
  const store = createMatrixApprovalStore(100);
  const request = createRequest("apr-2");
  const decisionPromise = store.request(request);

  assert.equal(store.cancel(request.id), true);
  assert.equal(await decisionPromise, "deny");
  assert.equal(store.peek(request.id), null);
});

test("matrix approval store expires pending requests", async () => {
  const store = createMatrixApprovalStore(10);
  const request = createRequest("apr-3");
  const decisionPromise = store.request(request);

  assert.equal(await decisionPromise, "deny");
  assert.equal(store.peek(request.id), null);
});
