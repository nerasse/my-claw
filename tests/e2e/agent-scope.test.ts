import { describe, test, expect, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mockFetch } from "../helpers/mock-fetch.ts";
import { startConfigWatcher } from "../../src/core/config-watcher.ts";
import { parseConfig, type MyClawConfig } from "../../src/core/config.ts";
import { loadAllSkills } from "../../src/skills/loader.ts";
import { SkillRegistry } from "../../src/skills/registry.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { createSkillsTool } from "../../src/tools/skills.ts";
import { AgentBridge } from "../../src/agent/bridge.ts";
import { MessageRouter } from "../../src/core/router.ts";
import { SessionManager } from "../../src/sessions/manager.ts";
import { hooks } from "../../src/hooks/index.ts";
import type { UnifiedMessage } from "../../src/channels/types.ts";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function configWith(agents: MyClawConfig["agents"]): MyClawConfig {
  return {
    whitelist: ["u1"],
    blacklist: [],
    channels: {},
    llm: { provider: "x", baseUrl: "https://api.example.com", model: "test-model" },
    agents,
    memory: { enabled: false },
  };
}

function message(text: string): UnifiedMessage {
  return {
    id: `m-${Math.random()}`, platform: "my-claw-app", userId: "u1", chatId: "c1",
    chatType: "dm", text, attachments: [], isForwarded: false, raw: {},
  };
}

function llmResponse(msg: object): never {
  return new Response(
    JSON.stringify({ choices: [{ message: msg }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  ) as never;
}

function waitForReload(timeoutMs = 5000): Promise<{ changed: string[] }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      hooks.off("config:reloaded", handler);
      reject(new Error("timed out waiting for config:reloaded"));
    }, timeoutMs);
    const handler = (payload: { changed: string[]; rebootRequired: string[] }) => {
      clearTimeout(timer);
      hooks.off("config:reloaded", handler);
      resolve(payload);
    };
    hooks.on("config:reloaded", handler);
    cleanups.push(() => hooks.off("config:reloaded", handler));
  });
}

/** Two real skills on disk, loaded the way the app loads them. */
async function realSkills(): Promise<SkillRegistry> {
  const dir = await mkdtemp(join(tmpdir(), "myclaw-scope-skills-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  for (const [name, body] of [["alpha", "ALPHA BODY"], ["beta", "BETA BODY"]] as const) {
    await mkdir(join(dir, name), { recursive: true });
    await writeFile(join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} does things\n---\n\n${body}`);
  }
  return new SkillRegistry(await loadAllSkills({ builtInDir: dir, customDir: dir, workspaceDir: dir }));
}

/**
 * A full stack over one live config object: real skills from disk, the real skill tools, a real
 * router and session manager. The LLM is scripted to drive one tool call per turn so the assertions
 * read the actual tool output the model would have received.
 */
function stack(config: MyClawConfig, skills: SkillRegistry, opts: { depth?: number; agentKind?: "general" | "research" } = {}) {
  const tools = new ToolRegistry();
  // The real tool, swapped for its read-only variant by the registry for every agent but the
  // orchestrator; nothing here writes, so its write dirs lead nowhere.
  tools.register(createSkillsTool(skills, config, { builtinDir: "/nonexistent", customDir: "/nonexistent", workspaceSkillsDir: "/nonexistent" }));
  const bridge = new AgentBridge(config, tools, skills, undefined, undefined, opts.depth ?? 0, undefined, opts.agentKind);
  return { router: new MessageRouter(new SessionManager(), bridge), bridge };
}

/** Route one message, forcing a single tool call, and return what the tool answered. */
async function callTool(
  router: MessageRouter,
  tool: string,
  args: Record<string, unknown>,
): Promise<{ toolOutput: string; systemPrompt: string }> {
  const bodies: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
  let call = 0;
  const mock = mockFetch(async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")));
    call++;
    if (call === 1) {
      return llmResponse({ content: "", tool_calls: [{ id: "tc1", function: { name: tool, arguments: JSON.stringify(args) } }] });
    }
    return llmResponse({ content: "done" });
  });
  try {
    await router.route(message(`use ${tool}`));
    // The session persists across calls, so the payload carries every past tool message: the one
    // this turn produced is the last, not the first.
    const toolMessages = (bodies[1]?.messages ?? []).filter((m) => m.role === "tool");
    const toolMsg = toolMessages.at(-1);
    const system = bodies[0]?.messages.find((m) => m.role === "system");
    return {
      toolOutput: typeof toolMsg?.content === "string" ? toolMsg.content : "",
      systemPrompt: typeof system?.content === "string" ? system.content : "",
    };
  } finally {
    mock.restore();
  }
}

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

describe("E2E agent scoping", () => {
  test("a scoped sub-agent sees, and can read, only its own skills", async () => {
    const skills = await realSkills();
    const config = configWith({ orchestrator: { skills: ["*"] }, general: { skills: ["alpha"] } });
    const { router } = stack(config, skills, { depth: 1, agentKind: "general" });

    const listed = await callTool(router, "skills", { name: "nope" });
    expect(listed.toolOutput).toContain("alpha");
    expect(listed.toolOutput).not.toContain("beta");
    // The prompt catalog and the tool must agree, or the model is told to read something it cannot.
    expect(listed.systemPrompt).toContain("- alpha: alpha does things");
    expect(listed.systemPrompt).not.toContain("beta");

    const allowed = await callTool(router, "skills", { name: "alpha" });
    expect(allowed.toolOutput).toContain("ALPHA BODY");

    const refused = await callTool(router, "skills", { name: "beta" });
    expect(refused.toolOutput).toContain("not in this agent's scope");
    expect(refused.toolOutput).not.toContain("BETA BODY");
  });

  test("the orchestrator on the same registry still reads everything", async () => {
    // Same skills, same files: the difference must come from the scope alone, not from what was
    // loaded, which is what makes a shared registry safe.
    const skills = await realSkills();
    const config = configWith({ orchestrator: { skills: ["*"] }, general: { skills: ["alpha"] } });
    const { router } = stack(config, skills, { depth: 0 });

    expect((await callTool(router, "skills", { name: "beta" })).toolOutput).toContain("BETA BODY");
    expect((await callTool(router, "skills", { name: "nope" })).toolOutput).toContain("beta");
  });

  test("editing the scope on disk applies to the next message, with no restart", async () => {
    const skills = await realSkills();
    const dir = await mkdtemp(join(tmpdir(), "myclaw-scope-cfg-"));
    const file = join(dir, "config.json");
    cleanups.push(() => rm(dir, { recursive: true, force: true }));

    const initial = configWith({ orchestrator: { skills: ["*"] }, general: { skills: ["alpha"] } });
    await writeFile(file, JSON.stringify(initial, null, 2));
    const config = parseConfig(await Bun.file(file).text());
    const { router } = stack(config, skills, { depth: 1, agentKind: "general" });

    const before = await callTool(router, "skills", { name: "beta" });
    expect(before.toolOutput).toContain("not in this agent's scope");

    const watcher = startConfigWatcher(config, {}, {
      path: file,
      read: async () => parseConfig(await Bun.file(file).text()),
      debounceMs: 20,
    });
    cleanups.push(() => watcher.stop());

    const reloaded = waitForReload();
    const widened = configWith({ orchestrator: { skills: ["*"] }, general: { skills: ["alpha", "beta"] } });
    await writeUntilReloaded(file, JSON.stringify(widened, null, 2), reloaded);
    expect((await reloaded).changed).toContain("agents");

    // No re-registration of the tools and no new bridge: both hold the same live config object, so
    // the widened scope has to be visible on the very next call. This is the claim docs/config.md
    // makes about `agents` being a hot section.
    const after = await callTool(router, "skills", { name: "beta" });
    expect(after.toolOutput).toContain("BETA BODY");
  });

  test("narrowing the scope on disk revokes access on the next message", async () => {
    // The opposite direction matters more: a stale permissive scope would keep granting access after
    // the owner removed it.
    const skills = await realSkills();
    const dir = await mkdtemp(join(tmpdir(), "myclaw-scope-cfg2-"));
    const file = join(dir, "config.json");
    cleanups.push(() => rm(dir, { recursive: true, force: true }));

    await writeFile(file, JSON.stringify(configWith({ general: { skills: ["alpha", "beta"] } }), null, 2));
    const config = parseConfig(await Bun.file(file).text());
    const { router } = stack(config, skills, { depth: 1, agentKind: "general" });
    expect((await callTool(router, "skills", { name: "beta" })).toolOutput).toContain("BETA BODY");

    const watcher = startConfigWatcher(config, {}, {
      path: file,
      read: async () => parseConfig(await Bun.file(file).text()),
      debounceMs: 20,
    });
    cleanups.push(() => watcher.stop());

    const reloaded = waitForReload();
    await writeUntilReloaded(file, JSON.stringify(configWith({ general: { skills: ["alpha"] } }), null, 2), reloaded);

    const after = await callTool(router, "skills", { name: "beta" });
    expect(after.toolOutput).toContain("not in this agent's scope");
    expect(after.systemPrompt).not.toContain("beta");
  });

  test("an unscoped config keeps every agent unrestricted end to end", async () => {
    const skills = await realSkills();
    const config = configWith({});
    for (const opts of [{ depth: 0 }, { depth: 1, agentKind: "general" as const }, { depth: 1, agentKind: "research" as const }]) {
      const { router } = stack(config, skills, opts);
      const listed = await callTool(router, "skills", { name: "nope" });
      expect(listed.toolOutput).toContain("alpha");
      expect(listed.toolOutput).toContain("beta");
      expect((await callTool(router, "skills", { name: "beta" })).toolOutput).toContain("BETA BODY");
    }
  });
});
