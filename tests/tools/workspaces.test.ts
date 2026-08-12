import { test, describe, beforeEach, afterEach } from "bun:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { SessionManager } from "../../src/sessions/manager.ts";
import { createWorkspacesTool } from "../../src/tools/workspaces.ts";
import { CONFIG_PATH, MY_CLAW_DIR, type MyClawConfig } from "../../src/core/config.ts";

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

/** Real directories the CRUD actions must be able to mkdir, inside the test's own MY_CLAW_DIR. */
const SOFA = join(MY_CLAW_DIR, "sofa");
const DEV = join(MY_CLAW_DIR, "dev");
const NEW_SOFA = join(MY_CLAW_DIR, "newsofa");

const BASE_FILE = {
  whitelist: [],
  blacklist: [],
  channels: {},
  llm: { provider: "t", baseUrl: "u", model: "m" },
  agents: { orchestrator: { workspace: "sofa" } },
  workspaces: { sofa: SOFA },
};

describe("workspaces tool", () => {
  let manager: SessionManager;
  let tool: ReturnType<typeof createWorkspacesTool>;
  let config: MyClawConfig;

  beforeEach(async () => {
    manager = new SessionManager();
    config = configWith({ sofa: SOFA });
    tool = createWorkspacesTool({
      sessionManager: manager,
      config,
      reload: async () => {
        // The hot-reload appliers mutate the live config object; the fake mirrors them from disk.
        const file = JSON.parse(await readFile(CONFIG_PATH, "utf-8")) as { workspaces?: Record<string, string> };
        config.workspaces = file.workspaces ?? {};
      },
    });
    await manager.getOrCreateWithMeta("my-claw-app/thread/o/t1", "my-claw-app", "dm");
  });

  afterEach(async () => {
    await rm(CONFIG_PATH, { force: true });
  });

  test("list shows every workspace with the current conversation marked", async () => {
    const result = await tool.execute({ action: "list", __sessionId: "my-claw-app/thread/o/t1" });
    assert.equal(result.success, true);
    assert.match(result.output, /- default: .+ <- current conversation/);
    assert.match(result.output, new RegExp(`- sofa: ${SOFA}`));
  });

  test("switch moves the session to the named workspace and persists", async () => {
    const result = await tool.execute({ action: "switch", key: "sofa", __sessionId: "my-claw-app/thread/o/t1" });
    assert.equal(result.success, true);
    assert.equal((await manager.peek("my-claw-app/thread/o/t1"))?.workspace, "sofa");

    const listed = await tool.execute({ action: "list", __sessionId: "my-claw-app/thread/o/t1" });
    assert.match(listed.output, new RegExp(`- sofa: ${SOFA} <- current conversation`));
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

  test("create declares the workspace, creates the directory and answers with the fresh list", async () => {
    await mkdir(dirname(CONFIG_PATH), { recursive: true });
    await writeFile(CONFIG_PATH, `${JSON.stringify(BASE_FILE, null, 2)}\n`);

    const result = await tool.execute({ action: "create", key: "dev", path: DEV });
    assert.equal(result.success, true);
    assert.match(result.output, /Workspace created: "dev"/);
    assert.match(result.output, new RegExp(`- dev: ${DEV}`));

    const file = JSON.parse(await readFile(CONFIG_PATH, "utf-8")) as { workspaces: Record<string, string> };
    assert.equal(file.workspaces["dev"], DEV);
  });

  test("create refuses a reserved or malformed key and a relative path", async () => {
    await mkdir(dirname(CONFIG_PATH), { recursive: true });
    await writeFile(CONFIG_PATH, `${JSON.stringify(BASE_FILE, null, 2)}\n`);

    const reserved = await tool.execute({ action: "create", key: "default", path: join(MY_CLAW_DIR, "x") });
    assert.equal(reserved.success, false);
    assert.match(reserved.error ?? "", /reserved/i);

    const relative = await tool.execute({ action: "create", key: "ok", path: "relative" });
    assert.equal(relative.success, false);
    assert.match(relative.error ?? "", /absolute/i);
  });

  test("remove drops the workspace and warns that leftover pins stay", async () => {
    await mkdir(dirname(CONFIG_PATH), { recursive: true });
    await writeFile(CONFIG_PATH, `${JSON.stringify(BASE_FILE, null, 2)}\n`);

    const result = await tool.execute({ action: "remove", key: "sofa" });
    assert.equal(result.success, true);
    assert.match(result.output, /Workspace removed: "sofa"/);
    assert.match(result.output, /flagged red/i);

    const file = JSON.parse(await readFile(CONFIG_PATH, "utf-8")) as { workspaces?: Record<string, string> };
    assert.equal(file.workspaces?.["sofa"], undefined);
  });

  test("rename rewrites the workspace key and answers with the fresh list", async () => {
    await mkdir(dirname(CONFIG_PATH), { recursive: true });
    await writeFile(CONFIG_PATH, `${JSON.stringify(BASE_FILE, null, 2)}\n`);

    const result = await tool.execute({ action: "rename", from: "sofa", to: "couch" });
    assert.equal(result.success, true);
    assert.match(result.output, new RegExp(`- couch: ${SOFA}`));
    assert.doesNotMatch(result.output, /- sofa:/);

    const file = JSON.parse(await readFile(CONFIG_PATH, "utf-8")) as {
      workspaces: Record<string, string>;
      agents: { orchestrator: { workspace: string } };
    };
    assert.equal(file.workspaces["couch"], SOFA);
    assert.equal(file.agents.orchestrator.workspace, "couch");
  });

  test("path repoints a workspace at another directory", async () => {
    await mkdir(dirname(CONFIG_PATH), { recursive: true });
    await writeFile(CONFIG_PATH, `${JSON.stringify(BASE_FILE, null, 2)}\n`);

    const result = await tool.execute({ action: "path", key: "sofa", path: NEW_SOFA });
    assert.equal(result.success, true);
    assert.match(result.output, new RegExp(`- sofa: ${NEW_SOFA}`));

    const file = JSON.parse(await readFile(CONFIG_PATH, "utf-8")) as { workspaces: Record<string, string> };
    assert.equal(file.workspaces["sofa"], NEW_SOFA);
  });
});
