import { test, describe, beforeEach } from "bun:test";
import assert from "node:assert/strict";
import { SessionManager } from "../../src/sessions/manager.ts";
import { createWorkspacesTool } from "../../src/tools/workspaces.ts";
import type { MyClawConfig } from "../../src/core/config.ts";

function configWith(workspaces: Record<string, string>): MyClawConfig {
  return {
    whitelist: [],
    blacklist: [],
    channels: {},
    llm: { provider: "t", baseUrl: "u", model: "m" },
    agents: {},
    workspaces,
  } as MyClawConfig;
}

describe("workspaces tool", () => {
  let manager: SessionManager;
  let tool: ReturnType<typeof createWorkspacesTool>;

  beforeEach(async () => {
    manager = new SessionManager();
    tool = createWorkspacesTool(manager, configWith({ sofa: "/srv/sofa", dev: "/srv/dev" }));
    await manager.getOrCreateWithMeta("my-claw-app/thread/o/t1", "my-claw-app", "dm");
  });

  test("list shows every workspace with the current conversation marked", async () => {
    const result = await tool.execute({ action: "list", __sessionId: "my-claw-app/thread/o/t1" });
    assert.equal(result.success, true);
    assert.match(result.output, /- default: .+ <- current conversation/);
    assert.match(result.output, /- sofa: \/srv\/sofa/);
    assert.match(result.output, /- dev: \/srv\/dev/);
  });

  test("switch moves the session to the named workspace and persists", async () => {
    const result = await tool.execute({ action: "switch", key: "sofa", __sessionId: "my-claw-app/thread/o/t1" });
    assert.equal(result.success, true);
    assert.equal((await manager.peek("my-claw-app/thread/o/t1"))?.workspace, "sofa");

    const listed = await tool.execute({ action: "list", __sessionId: "my-claw-app/thread/o/t1" });
    assert.match(listed.output, /- sofa: \/srv\/sofa <- current conversation/);
  });

  test("switch back to default clears the stored key", async () => {
    await tool.execute({ action: "switch", key: "sofa", __sessionId: "my-claw-app/thread/o/t1" });
    const result = await tool.execute({ action: "switch", key: "default", __sessionId: "my-claw-app/thread/o/t1" });
    assert.equal(result.success, true);
    assert.equal((await manager.peek("my-claw-app/thread/o/t1"))?.workspace, undefined);
  });

  test("an unknown key is refused with the list hint", async () => {
    const result = await tool.execute({ action: "switch", key: "mars", __sessionId: "my-claw-app/thread/o/t1" });
    assert.equal(result.success, false);
    assert.match(result.error ?? "", /unknown workspace: mars/);
  });

  test("switch without a key reports the missing argument", async () => {
    const result = await tool.execute({ action: "switch", __sessionId: "my-claw-app/thread/o/t1" });
    assert.equal(result.success, false);
    assert.match(result.error ?? "", /key is required/);
  });
});
