import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMatrixApprovalStore } from "../src/channels/matrix/approval-store.ts";
import { createMatrixApprovalHandler } from "../src/channels/matrix/session-handlers.ts";
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
  const store = createMatrixApprovalStore(100, { unrefTimers: false });
  const request = createRequest("apr-1");
  const decisionPromise = store.request(request);

  const resolved = store.resolve(request.id, "allow-session");
  assert.deepEqual(resolved, { request, expired: false });
  assert.equal(await decisionPromise, "allow-session");
  store.clear();
});

test("matrix approval store cancels pending requests", async () => {
  const store = createMatrixApprovalStore(100, { unrefTimers: false });
  const request = createRequest("apr-2");
  const decisionPromise = store.request(request);

  assert.equal(store.cancel(request.id), true);
  assert.equal(await decisionPromise, "deny");
  assert.equal(store.peek(request.id), null);
  store.clear();
});

test("matrix approval store expires pending requests", async () => {
  const store = createMatrixApprovalStore(1, { unrefTimers: false });
  const request = createRequest("apr-3");
  const decisionPromise = store.request(request);

  assert.equal(await decisionPromise, "deny");
  assert.equal(store.peek(request.id), null);
  store.clear();
});

test("matrix approval handler restores pending approvals after restart as expired prompts", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "my-claw-matrix-approval-"));
  try {
    const storagePath = join(tempDir, "pending-approvals.json");
    await writeFile(
      storagePath,
      JSON.stringify([{ request: createRequest("apr-restart"), expiresAt: Date.now() + 60_000 }], null, 2),
    );

    const second = createMatrixApprovalHandler(storagePath);
    await second.restorePendingApprovals();
    const resolved = await second.resolveAction({
      chatId: "!room:test",
      userId: "@u1:example.org",
      chatType: "group",
    data: "apr:once:apr-restart",
    messageId: "$approval",
  });

    assert.match(resolved?.text ?? "", /expired/i);
    await second.persistPendingApprovals();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
