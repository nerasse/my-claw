import { describe, test, expect, afterEach } from "bun:test";
import { readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createMyClawAppCommandHandler } from "../../src/channels/my-claw-app/commands.ts";
import { AgentRegistry } from "../../src/agents/registry.ts";
import { SessionManager } from "../../src/sessions/manager.ts";
import { ModelPicker } from "../../src/channels/model-picker.ts";
import { CONFIG_PATH, type MyClawConfig } from "../../src/core/config.ts";
import type { SubAgentInfo } from "../../src/subagents/types.ts";
import type { OutgoingMessage } from "../../src/channels/types.ts";

/**
 * `/model <agent> <model>` is only useful if it lands in config.json and leaves the conversation
 * alone. These go through the real channel handler, because a dropped agent target would silently
 * redirect the write to the session instead.
 */

const LLM = {
  defaultProvider: "litellm",
  defaultModel: "mimo",
  providers: { litellm: { baseUrl: "https://litellm.test/v1" }, anthropic: { type: "anthropic" as const } },
  models: [
    { id: "mimo", label: "Mimo", provider: "litellm" },
    { id: "opus", label: "Opus", provider: "anthropic" },
  ],
};

const INSTANCES: SubAgentInfo[] = [
  { id: "subagent/digger-c3d4", displayName: "digger", type: "research", messageCount: 2, status: "idle", visibility: "global", createdAt: "2026-01-01T00:00:00.000Z" },
];

function config(): MyClawConfig {
  return { whitelist: ["u1"], blacklist: [], channels: {}, llm: structuredClone(LLM), agents: {} } as MyClawConfig;
}

/** The two shipped built-ins: `/model <agent>` targets come from the registry, not a union. */
function agentRegistry(): AgentRegistry {
  const meta = (base: "general" | "research") =>
    ({ description: `${base} agent`, base, instructions: ["CORE", "SOUL", "AGENTS", "USER"] as const });
  return new AgentRegistry(new Map([
    ["general", { name: "general", meta: { ...meta("general"), instructions: [...meta("general").instructions] }, prompt: "", path: "/g.md", source: "built-in" as const }],
    ["research", { name: "research", meta: { ...meta("research"), instructions: [...meta("research").instructions] }, prompt: "", path: "/r.md", source: "built-in" as const }],
  ]));
}

function harness(cfg: MyClawConfig) {
  const sessionManager = new SessionManager();
  const registry = agentRegistry();
  const modelPicker = new ModelPicker([], undefined, () => registry.names());
  modelPicker.syncFromConfig(cfg.llm);
  const deps = {
    config: cfg,
    sessionManager,
    modelPicker,
    agentRegistry: registry,
    listSubAgents: async () => INSTANCES,
    reloadConfigNow: async () => ({ changed: [], rebootRequired: [] }),
  };
  return {
    sessionManager,
    modelPicker,
    app: createMyClawAppCommandHandler(deps),
  };
}

async function writeConfigFile(): Promise<void> {
  await mkdir(dirname(CONFIG_PATH), { recursive: true });
  await writeFile(CONFIG_PATH, `${JSON.stringify({ whitelist: ["u1"], channels: {}, llm: LLM, agents: {} }, null, 2)}\n`);
}

async function readConfigFile(): Promise<Record<string, any>> {
  return JSON.parse(await readFile(CONFIG_PATH, "utf-8"));
}

afterEach(async () => {
  await rm(CONFIG_PATH, { force: true });
});

describe("/model <agent> on the app channel", () => {
  test("/model <agent> answers with the agent target and its current model", async () => {
    const cfg = config();
    const h = harness(cfg);
    const reply = String(await h.app("u1", "t1", "model", "research"));
    expect(reply).toContain("research");
    // The app has no button menu: the answer points at the typed form instead.
    expect(reply).toContain("/model <agent> <mod");
  });

  test("a plain /model <model> is untouched and still changes only the session", async () => {
    const cfg = config();
    const h = harness(cfg);
    await writeConfigFile();
    const reply = await h.app("u1", "t1", "model", "opus");
    expect(String(reply)).toContain("Model changed");
    expect((await readConfigFile())["agents"]).toEqual({});
  });

  test("/model <agent> <model> writes config and leaves the conversation alone", async () => {
    const cfg = config();
    const h = harness(cfg);
    await writeConfigFile();

    const reply = String(await h.app("u1", "t1", "model", "research opus"));
    expect(reply).toContain("research");
    expect((await readConfigFile())["agents"]["research"]["llm"])
      .toEqual({ defaultModel: "opus", defaultProvider: "anthropic" });
    // The conversation the owner was sitting in must not have moved.
    const sessionId = SessionManager.resolveSessionId("my-claw-app", "dm", "u1", "u1", { threadId: "t1", sessionScope: "per-user" });
    expect((await h.sessionManager.peek(sessionId))?.modelOverride).toBeUndefined();
  });

  test("the cron agent is targetable by name like any other", async () => {
    const cfg = config();
    const h = harness(cfg);
    await writeConfigFile();
    const reply = String(await h.app("u1", "t1", "model", "cron opus"));
    expect(reply).toContain("cron");
    expect((await readConfigFile())["agents"]["cron"]["llm"]["defaultModel"]).toBe("opus");
  });

  test("a live sub-agent name reaches its type's config entry", async () => {
    const cfg = config();
    const h = harness(cfg);
    await writeConfigFile();
    const reply = await h.app("u1", "t1", "model", "subagent/digger-c3d4 opus");
    expect(String(reply)).toContain("research");
    expect((await readConfigFile())["agents"]["research"]["llm"]["defaultModel"]).toBe("opus");
  });
});
