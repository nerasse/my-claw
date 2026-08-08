import { describe, test, expect, afterEach } from "bun:test";
import { readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  setAgentModel,
  setDefaultModel,
  setDefaultEffort,
  clearAgentModel,
  setAgentScope,
  setAgentWorkspace,
  setAgentMaxIterations,
  setToolDisabled,
  addMcpServer,
  removeMcpServer,
  setMcpEnabled,
  addWorkspace,
  removeWorkspace,
  renameWorkspace,
  setWorkspacePath,
} from "../../src/core/config-edit.ts";
import { CONFIG_PATH, parseConfig, resolveAgentLlm, MY_CLAW_DIR, type MyClawConfig } from "../../src/core/config.ts";
import { join } from "node:path";

const FILE = {
  whitelist: ["u1"],
  channels: {},
  llm: {
    defaultProvider: "litellm",
    defaultModel: "mimo",
    providers: { litellm: { baseUrl: "https://litellm.test/v1" }, anthropic: { type: "claude-sdk" } },
    models: [
      { id: "mimo", label: "Mimo", provider: "litellm" },
      { id: "opus", label: "Opus", provider: "anthropic" },
    ],
  },
  agents: { orchestrator: { maxIterations: 90 } },
};

async function writeConfigFile(data: unknown = FILE): Promise<void> {
  await mkdir(dirname(CONFIG_PATH), { recursive: true });
  await writeFile(CONFIG_PATH, `${JSON.stringify(data, null, 2)}\n`);
}

async function readConfigFile(): Promise<Record<string, any>> {
  return JSON.parse(await readFile(CONFIG_PATH, "utf-8"));
}

afterEach(async () => {
  await rm(CONFIG_PATH, { force: true });
});

describe("setDefaultModel", () => {
  test("writes llm.defaultModel and the provider", async () => {
    await writeConfigFile();
    const result = await setDefaultModel("opus", "anthropic");
    expect(result.ok).toBe(true);
    const file = await readConfigFile();
    expect(file.llm.defaultModel).toBe("opus");
    expect(file.llm.defaultProvider).toBe("anthropic");
  });

  test("records the previous default", async () => {
    await writeConfigFile();
    const result = await setDefaultModel("opus", "anthropic");
    if (!result.ok) throw new Error(result.error);
    expect(result.previous).toEqual({ model: "mimo", provider: "litellm" });
  });

  test("deletes a stale provider when the model has none", async () => {
    await writeConfigFile();
    await setDefaultModel("naked-model", undefined);
    const file = await readConfigFile();
    expect(file.llm.defaultModel).toBe("naked-model");
    expect(file.llm.defaultProvider).toBeUndefined();
  });

  test("leaves the rest of the file untouched", async () => {
    await writeConfigFile();
    await setDefaultModel("opus", "anthropic");
    const file = await readConfigFile();
    expect(file.whitelist).toEqual(["u1"]);
    expect(file.agents.orchestrator.maxIterations).toBe(90);
    expect(file.llm.models).toHaveLength(2);
  });

  test("refuses to overwrite an unparsable file", async () => {
    await mkdir(dirname(CONFIG_PATH), { recursive: true });
    await writeFile(CONFIG_PATH, '{ "llm": broken');
    const result = await setDefaultModel("opus", "anthropic");
    expect(result.ok).toBe(false);
    expect(await readFile(CONFIG_PATH, "utf-8")).toBe('{ "llm": broken');
  });
});

describe("setDefaultEffort", () => {
  test("writes llm.effort", async () => {
    await writeConfigFile();
    await setDefaultEffort("high");
    expect((await readConfigFile()).llm.effort).toBe("high");
  });

  test("undefined removes the key", async () => {
    await writeConfigFile();
    await setDefaultEffort("high");
    await setDefaultEffort(undefined);
    const file = await readConfigFile();
    expect(file.llm.effort).toBeUndefined();
  });
});

describe("clearAgentModel", () => {
  test("removes the pin and leaves the rest of the agent intact", async () => {
    await writeConfigFile();
    await setAgentModel("cron", "opus", "anthropic");
    const result = await clearAgentModel("cron");
    expect(result.ok).toBe(true);
    const file = await readConfigFile();
    expect(file.agents.cron).toBeUndefined();
    expect(file.agents.orchestrator.maxIterations).toBe(90);
  });

  test("reports the removed values", async () => {
    await writeConfigFile();
    await setAgentModel("cron", "opus", "anthropic");
    const result = await clearAgentModel("cron");
    if (!result.ok) throw new Error(result.error);
    expect(result.previous).toEqual({ model: "opus", provider: "anthropic" });
  });

  test("drops the emptied llm object and the emptied agent entry", async () => {
    await writeConfigFile();
    await setAgentModel("general", "opus", "anthropic");
    const fileAfterPin = await readConfigFile();
    expect(fileAfterPin.agents.general.llm).toEqual({ defaultModel: "opus", defaultProvider: "anthropic" });
    await clearAgentModel("general");
    const file = await readConfigFile();
    expect(file.agents.general).toBeUndefined();
    expect(file.agents.orchestrator.maxIterations).toBe(90);
  });

  test("the unpinned agent resolves back to the global default", async () => {
    await writeConfigFile();
    await setAgentModel("general", "opus", "anthropic");
    await clearAgentModel("general");
    const reloaded = parseConfig(await readFile(CONFIG_PATH, "utf-8"));
    expect(resolveAgentLlm(reloaded, "general")).toBeUndefined();
  });

  test("the written file survives a parseConfig round-trip", async () => {
    await writeConfigFile();
    await setDefaultModel("opus", "anthropic");
    await setAgentModel("cron", "opus", "anthropic");
    const reloaded = parseConfig(await readFile(CONFIG_PATH, "utf-8"));
    expect(reloaded.llm.defaultModel).toBe("opus");
    expect(reloaded.agents.cron?.llm?.defaultModel).toBe("opus");
  });
});

describe("setAgentScope", () => {
  test("writes the names as the agent's list", async () => {
    await writeConfigFile();
    const result = await setAgentScope("cron", "skills", "list", ["code-review", "voice"]);
    expect(result.ok).toBe(true);
    expect((await readConfigFile()).agents.cron.skills).toEqual(["code-review", "voice"]);
  });

  test("mode all writes the wildcard", async () => {
    await writeConfigFile();
    await setAgentScope("cron", "mcp", "all");
    expect((await readConfigFile()).agents.cron.mcp).toEqual(["*"]);
  });

  test("mode inherit removes the key and drops an emptied agent entry", async () => {
    await writeConfigFile();
    await setAgentScope("cron", "skills", "list", ["voice"]);
    await setAgentScope("cron", "skills", "inherit");
    const file = await readConfigFile();
    expect(file.agents.cron).toBeUndefined();
    expect(file.agents.orchestrator.maxIterations).toBe(90);
  });

  test("an empty list is a decision, not an absent field", async () => {
    await writeConfigFile();
    await setAgentScope("cron", "skills", "list", []);
    expect((await readConfigFile()).agents.cron.skills).toEqual([]);
  });

  test("dedupes the names while keeping the user's order", async () => {
    await writeConfigFile();
    await setAgentScope("cron", "skills", "list", ["a", "b", "a"]);
    expect((await readConfigFile()).agents.cron.skills).toEqual(["a", "b"]);
  });

  test("the written file survives a parseConfig round-trip", async () => {
    await writeConfigFile();
    await setAgentScope("cron", "mcp", "list", ["mailcow", "ghost"]);
    const reloaded = parseConfig(await readFile(CONFIG_PATH, "utf-8"));
    expect(reloaded.agents.cron?.mcp).toEqual(["mailcow", "ghost"]);
  });
});

describe("setAgentWorkspace", () => {
  test("writes the key when it exists in config.workspaces", async () => {
    await writeConfigFile({ ...FILE, workspaces: { sofa: "/srv/sofa" } });
    const result = await setAgentWorkspace("cron", "sofa");
    expect(result.ok).toBe(true);
    expect((await readConfigFile()).agents.cron.workspace).toBe("sofa");
  });

  test("refuses a key that is not in config.workspaces", async () => {
    await writeConfigFile({ ...FILE, workspaces: { sofa: "/srv/sofa" } });
    const result = await setAgentWorkspace("cron", "ghost");
    expect(result.ok).toBe(false);
    expect((await readConfigFile()).agents.cron).toBeUndefined();
  });

  test("null removes the pin", async () => {
    await writeConfigFile({ ...FILE, workspaces: { sofa: "/srv/sofa" } });
    await setAgentWorkspace("cron", "sofa");
    await setAgentWorkspace("cron", null);
    const file = await readConfigFile();
    expect(file.agents.cron).toBeUndefined();
  });
});

describe("setAgentMaxIterations", () => {
  test("writes a positive integer", async () => {
    await writeConfigFile();
    const result = await setAgentMaxIterations("cron", 12);
    expect(result.ok).toBe(true);
    expect((await readConfigFile()).agents.cron.maxIterations).toBe(12);
  });

  test("refuses zero and negatives", async () => {
    await writeConfigFile();
    expect((await setAgentMaxIterations("cron", 0)).ok).toBe(false);
    expect((await setAgentMaxIterations("cron", -3)).ok).toBe(false);
    expect(await readConfigFile()).toEqual(FILE);
  });

  test("null removes the key", async () => {
    await writeConfigFile();
    await setAgentMaxIterations("cron", 12);
    await setAgentMaxIterations("cron", null);
    expect((await readConfigFile()).agents.cron).toBeUndefined();
  });
});

describe("setToolDisabled", () => {
  test("adds a name to the denylist", async () => {
    await writeConfigFile();
    const result = await setToolDisabled("cron", true);
    expect(result.ok).toBe(true);
    expect((await readConfigFile()).tools.disabled).toEqual(["cron"]);
  });

  test("removes the name and drops the emptied tools section", async () => {
    await writeConfigFile();
    await setToolDisabled("cron", true);
    await setToolDisabled("cron", false);
    const file = await readConfigFile();
    expect(file.tools).toBeUndefined();
  });

  test("leaves other disabled names alone", async () => {
    await writeConfigFile({ ...FILE, tools: { disabled: ["bash"] } });
    await setToolDisabled("cron", true);
    expect((await readConfigFile()).tools.disabled).toEqual(["bash", "cron"]);
  });
});

describe("MCP server writes", () => {
  test("addMcpServer declares a stdio server with command and args", async () => {
    await writeConfigFile();
    const result = await addMcpServer("mailcow", { transport: "stdio", command: "mcp-mail", args: ["--port", "2525"] });
    expect(result.ok).toBe(true);
    const file = await readConfigFile();
    expect(file.mcp.mailcow).toEqual({ transport: "stdio", command: "mcp-mail", args: ["--port", "2525"] });
  });

  test("addMcpServer declares an http server with a url", async () => {
    await writeConfigFile();
    const result = await addMcpServer("weather", { transport: "http", url: "http://mcp.local" });
    expect(result.ok).toBe(true);
    expect((await readConfigFile()).mcp.weather.url).toBe("http://mcp.local");
  });

  test("addMcpServer refuses a spec that does not match the transport", async () => {
    await writeConfigFile();
    expect((await addMcpServer("mailcow", { transport: "stdio" })).ok).toBe(false);
    expect((await addMcpServer("weather", { transport: "sse" })).ok).toBe(false);
  });

  test("addMcpServer refuses a duplicate or a bad name", async () => {
    await writeConfigFile({ ...FILE, mcp: { mailcow: { transport: "stdio", command: "mcp" } } });
    expect((await addMcpServer("mailcow", { transport: "stdio", command: "x" })).ok).toBe(false);
    expect((await addMcpServer("bad/name", { transport: "stdio", command: "x" })).ok).toBe(false);
  });

  test("removeMcpServer deletes the key and drops an emptied mcp section", async () => {
    await writeConfigFile({ ...FILE, mcp: { mailcow: { transport: "stdio", command: "mcp" } } });
    const result = await removeMcpServer("mailcow");
    expect(result.ok).toBe(true);
    const file = await readConfigFile();
    expect(file.mcp).toBeUndefined();
  });

  test("setMcpEnabled writes enabled: false and removes it again on enable", async () => {
    await writeConfigFile({ ...FILE, mcp: { mailcow: { transport: "stdio", command: "mcp" } } });
    await setMcpEnabled("mailcow", false);
    expect((await readConfigFile()).mcp.mailcow.enabled).toBe(false);
    await setMcpEnabled("mailcow", true);
    expect((await readConfigFile()).mcp.mailcow.enabled).toBeUndefined();
  });

  test("removeMcpServer refuses a name that is not declared", async () => {
    await writeConfigFile();
    expect((await removeMcpServer("ghost")).ok).toBe(false);
  });
});

describe("workspace CRUD", () => {
  test("addWorkspace declares a key -> path pair", async () => {
    await writeConfigFile();
    const result = await addWorkspace("sofa", join(MY_CLAW_DIR, "sofa"));
    expect(result.ok).toBe(true);
    expect((await readConfigFile()).workspaces.sofa).toBe(join(MY_CLAW_DIR, "sofa"));
  });

  test("addWorkspace refuses a reserved key, a slash and a relative path", async () => {
    await writeConfigFile();
    expect((await addWorkspace("default", join(MY_CLAW_DIR, "x"))).ok).toBe(false);
    expect((await addWorkspace("a/b", join(MY_CLAW_DIR, "x"))).ok).toBe(false);
    expect((await addWorkspace("sofa", "relative")).ok).toBe(false);
  });

  test("addWorkspace refuses a duplicate key", async () => {
    await writeConfigFile({ ...FILE, workspaces: { sofa: join(MY_CLAW_DIR, "sofa") } });
    expect((await addWorkspace("sofa", join(MY_CLAW_DIR, "other"))).ok).toBe(false);
  });

  test("removeWorkspace deletes the key and drops an emptied section", async () => {
    await writeConfigFile({ ...FILE, workspaces: { sofa: join(MY_CLAW_DIR, "sofa") } });
    const result = await removeWorkspace("sofa");
    expect(result.ok).toBe(true);
    const file = await readConfigFile();
    expect(file.workspaces).toBeUndefined();
  });

  test("removeWorkspace refuses a key that is not declared", async () => {
    await writeConfigFile();
    expect((await removeWorkspace("ghost")).ok).toBe(false);
  });

  test("renameWorkspace moves the key and rewrites agent pins pointing at it", async () => {
    await writeConfigFile({ ...FILE, workspaces: { sofa: join(MY_CLAW_DIR, "sofa") }, agents: { ...FILE.agents, cron: { workspace: "sofa" } } });
    const result = await renameWorkspace("sofa", "couch");
    expect(result.ok).toBe(true);
    const file = await readConfigFile();
    expect(file.workspaces.sofa).toBeUndefined();
    expect(file.workspaces.couch).toBe(join(MY_CLAW_DIR, "sofa"));
    expect(file.agents.cron.workspace).toBe("couch");
    expect(file.agents.orchestrator.maxIterations).toBe(90);
  });

  test("renameWorkspace refuses a target that exists or a source that does not", async () => {
    await writeConfigFile({ ...FILE, workspaces: { sofa: join(MY_CLAW_DIR, "sofa"), couch: join(MY_CLAW_DIR, "couch") } });
    expect((await renameWorkspace("sofa", "couch")).ok).toBe(false);
    expect((await renameWorkspace("ghost", "couch2")).ok).toBe(false);
  });

  test("setWorkspacePath repoints the key and refuses unknown keys", async () => {
    await writeConfigFile({ ...FILE, workspaces: { sofa: join(MY_CLAW_DIR, "sofa") } });
    const result = await setWorkspacePath("sofa", join(MY_CLAW_DIR, "newsofa"));
    expect(result.ok).toBe(true);
    expect((await readConfigFile()).workspaces.sofa).toBe(join(MY_CLAW_DIR, "newsofa"));
    expect((await setWorkspacePath("ghost", join(MY_CLAW_DIR, "x"))).ok).toBe(false);
  });

  test("the written file survives a parseConfig round-trip", async () => {
    await writeConfigFile();
    await addWorkspace("sofa", join(MY_CLAW_DIR, "sofa"));
    const reloaded = parseConfig(await readFile(CONFIG_PATH, "utf-8"));
    expect(reloaded.workspaces?.sofa).toBe(join(MY_CLAW_DIR, "sofa"));
  });
});
