import { describe, test, expect, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createMyClawAppCommandHandler } from "../../src/channels/my-claw-app/commands.ts";
import { getHelpText, COMMANDS, commandsFor } from "../../src/channels/commands-catalog.ts";
import { isMetaCommand } from "../../src/channels/meta-commands.ts";
import { ModelPicker } from "../../src/channels/model-picker.ts";
import { SessionManager } from "../../src/sessions/manager.ts";
import { SkillRegistry } from "../../src/skills/registry.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { loadAllSkills } from "../../src/skills/loader.ts";
import { AgentRegistry } from "../../src/agents/registry.ts";
import { loadAllAgents } from "../../src/agents/loader.ts";
import { McpManager } from "../../src/mcp/manager.ts";
import { startConfigWatcher } from "../../src/core/config-watcher.ts";
import { parseConfig, type MyClawConfig } from "../../src/core/config.ts";
import { cleanupGeneratedTempFiles } from "../../src/utils/media.ts";
import { hooks } from "../../src/hooks/index.ts";
import type { OutgoingMessage } from "../../src/channels/types.ts";

const NEW_COMMANDS = ["skills", "agents", "mcp", "instructions"] as const;

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function baseConfig(agents: MyClawConfig["agents"] = {}): MyClawConfig {
  return {
    whitelist: ["u1"], blacklist: [], channels: {},
    llm: { provider: "x", baseUrl: "https://example.com", model: "test-model", models: [{ id: "test-model", label: "T" }] },
    agents,
  };
}

/** Two real skills on disk, loaded the way the app loads them. */
async function realSkills(): Promise<SkillRegistry> {
  const dir = await mkdtemp(join(tmpdir(), "introspect-skills-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  for (const name of ["alpha", "beta"]) {
    await mkdir(join(dir, name), { recursive: true });
    await writeFile(join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} does things\n---\n\n${name.toUpperCase()} BODY`);
  }
  return new SkillRegistry(await loadAllSkills({ builtInDir: dir, customDir: dir, workspaceDir: dir }));
}

/** The agents the release actually ships, so the e2e sees the catalog a real boot would have. */
async function realAgents(): Promise<AgentRegistry> {
  return new AgentRegistry(await loadAllAgents({
    builtInDir: join(import.meta.dir, "..", "..", "src", "agents", "builtin"),
    customDir: join(tmpdir(), "no-such-agents-dir"),
  }));
}

function toolRegistry(): ToolRegistry {
  const tools = new ToolRegistry();
  for (const n of ["read", "search", "ls", "fetch", "web_search", "list_skills", "read_skill", "manage_skills", "bash"]) {
    tools.register({ name: n, description: n, parameters: { type: "object", properties: {} }, execute: async () => ({ success: true, output: "" }) });
  }
  return tools;
}

type Handler = (owner: string, threadId: string, command: string, args: string) => Promise<OutgoingMessage | string | undefined>;

/** The real command handler over one live config, as index.ts wires it. */
async function handlers(config: MyClawConfig, mcp?: McpManager): Promise<{ app: Handler }> {
  const skills = await realSkills();
  const deps = {
    config,
    sessionManager: new SessionManager(),
    modelPicker: new ModelPicker(config.llm.models ?? []),
    skillRegistry: skills,
    agentRegistry: await realAgents(),
    toolRegistry: toolRegistry(),
    mcpStatus: () => mcp?.status() ?? [],
    listSubAgents: async () => [
      { id: "subagent/deploy-a1b2", displayName: "deploy", type: "general" as const, messageCount: 3, status: "idle" as const, visibility: "global" as const, createdAt: "2026-01-01T00:00:00.000Z" },
    ],
  };
  return { app: createMyClawAppCommandHandler(deps) as Handler };
}

const text = (r: OutgoingMessage | string | undefined): string =>
  typeof r === "string" ? r : typeof r === "object" && r ? r.text : "";

/**
 * Bun's fs.watch is not active when watch() returns: under load a single write can beat its
 * registration and be lost outright. Re-touch until the watcher reacts, so the test measures the
 * reload and not the registration latency. The interval must stay above the watcher's debounce or
 * every poke re-arms the timer and starves the reload.
 */
async function writeUntilReloaded(file: string, content: string, reloaded: Promise<unknown>): Promise<void> {
  await writeFile(file, content);
  // Swallow the write error: the directory is removed by afterEach, and a rejection escaping this
  // interval surfaces as an unhandled rejection charged to whichever test runs next.
  const retouch = setInterval(() => { void writeFile(file, content).catch(() => {}); }, 100);
  // Registered as a cleanup as well as cleared below: when Bun times a test out it abandons the
  // body without running `finally`, and the surviving interval then poisons the following tests.
  cleanups.push(() => clearInterval(retouch));
  try {
    await reloaded;
  } finally {
    clearInterval(retouch);
  }
}

describe("E2E introspection commands", () => {
  test("all four answer", async () => {
    const h = await handlers(baseConfig({ general: { skills: ["alpha"] } }));
    for (const command of NEW_COMMANDS) {
      const out = text(await h.app("u1", "t1", command, ""));
      expect(out.length).toBeGreaterThan(0);
    }
  });

  test("the agent argument is honoured through the channel handler", async () => {
    const h = await handlers(baseConfig({ orchestrator: { skills: ["*"] }, general: { skills: ["alpha"] } }));
    const scoped = text(await h.app("u1", "t1", "skills", "general"));
    expect(scoped).toContain("- alpha:");
    expect(scoped).not.toContain("- beta:");

    const all = text(await h.app("u1", "t1", "skills", ""));
    expect(all).toContain("- beta:");

    // A live sub-agent id resolves through its type.
    const byId = text(await h.app("u1", "t1", "skills", "subagent/deploy-a1b2"));
    expect(byId).toContain("(type general)");
    expect(byId).not.toContain("- beta:");
  });

  test("/mcp reports a really-failed server through the real manager", async () => {
    const mcp = new McpManager();
    cleanups.push(() => mcp.stop());
    await mcp.sync({ broken: { transport: "stdio", command: "definitely-not-a-real-binary-xyz" } });

    const h = await handlers(baseConfig(), mcp);
    const out = text(await h.app("u1", "t1", "mcp", ""));
    expect(out).toContain("broken | stdio | failed");
    expect(out).toContain("1 sur 1");
  });

  test("/instructions inlines the dump and leaves no temp file behind", async () => {
    const h = await handlers(baseConfig());
    const res = await h.app("u1", "t1", "instructions", "");
    // The app inlines the dump: a frame carries the whole text, so there is no attachment to
    // send and no file to clean up afterwards.
    const body = text(res);
    expect(body).toContain("# Available tools");
    expect(body).not.toContain("[object Object]");
    expect((res as OutgoingMessage).attachments ?? []).toHaveLength(0);
  });

  test("a scope edited on disk shows up in the next command, with no restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "introspect-cfg-"));
    const file = join(dir, "config.json");
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    await writeFile(file, JSON.stringify(baseConfig({ general: { skills: ["alpha"] } }), null, 2));

    const config = parseConfig(await Bun.file(file).text());
    const h = await handlers(config);
    expect(text(await h.app("u1", "t1", "skills", "general"))).not.toContain("- beta:");

    const watcher = startConfigWatcher(config, {}, {
      path: file,
      read: async () => parseConfig(await Bun.file(file).text()),
      debounceMs: 20,
    });
    cleanups.push(() => watcher.stop());

    const reloaded = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for config:reloaded")), 5000);
      const handler = () => { clearTimeout(timer); hooks.off("config:reloaded", handler); resolve(); };
      hooks.on("config:reloaded", handler);
      cleanups.push(() => hooks.off("config:reloaded", handler));
    });
    await writeUntilReloaded(file, JSON.stringify(baseConfig({ general: { skills: ["alpha", "beta"] } }), null, 2), reloaded);

    // The handler holds the same live config object, so no re-registration should be needed.
    expect(text(await h.app("u1", "t1", "skills", "general"))).toContain("- beta:");
  });

  test("each command is routable and discoverable", async () => {
    for (const command of NEW_COMMANDS) {
      // Without this the command and its reply are replayed to the LLM as conversation context.
      expect(isMetaCommand(`/${command}`)).toBe(true);
      expect(isMetaCommand(`/${command}@mybot`)).toBe(true);
      // Drives /help and the app slash-menu.
      expect(COMMANDS.some((c) => c.command === command)).toBe(true);
      expect(getHelpText("my-claw-app")).toContain(`/${command}`);
      expect(commandsFor("my-claw-app").some((c) => c.command === command)).toBe(true);
    }
  });

  test("a command that is advertised nowhere does not run either", () => {
    // A hidden command that still works is exactly what we refuse to ship.
    expect(COMMANDS.some((c) => c.command === "clear")).toBe(false);
    expect(isMetaCommand("/clear")).toBe(false);
  });

  test("an unknown agent name is reported, not silently treated as the orchestrator", async () => {
    const h = await handlers(baseConfig({ general: { skills: ["alpha"] } }));
    for (const command of ["skills", "mcp", "instructions"]) {
      const out = text(await h.app("u1", "t1", command, "ghost-agent"));
      expect(out).toContain("Agent inconnu : ghost-agent");
    }
  });

  test("the commands still answer when no MCP manager or runner is wired", async () => {
    // A read-only command must degrade, not throw, if the host omitted an optional dep.
    const config = baseConfig();
    const handler = createMyClawAppCommandHandler({
      config,
      sessionManager: new SessionManager(),
      modelPicker: new ModelPicker([]),
      skillRegistry: await realSkills(),
      agentRegistry: await realAgents(),
      toolRegistry: toolRegistry(),
    }) as Handler;
    expect(text(await handler("u1", "t1", "mcp", ""))).toContain("Aucun serveur déclaré");
    expect(text(await handler("u1", "t1", "agents", ""))).toContain("- (aucun)");
  });

  test("without the registries the commands report the gap instead of throwing", async () => {
    const handler = createMyClawAppCommandHandler({
      config: baseConfig(),
      sessionManager: new SessionManager(),
      modelPicker: new ModelPicker([]),
    }) as Handler;
    expect(text(await handler("u1", "t1", "skills", ""))).toContain("Introspection unavailable");
  });
});
