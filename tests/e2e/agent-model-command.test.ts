import { describe, test, expect, afterEach } from "bun:test";
import { readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  createTelegramCommandHandler,
  createTelegramCallbackHandler,
} from "../../src/channels/telegram/session-handlers.ts";
import {
  createMatrixCommandHandler,
  createMatrixActionHandler,
} from "../../src/channels/matrix/session-handlers.ts";
import { AgentRegistry } from "../../src/agents/registry.ts";
import { SessionManager } from "../../src/sessions/manager.ts";
import { ModelPicker } from "../../src/channels/model-picker.ts";
import { CONFIG_PATH, type MyClawConfig } from "../../src/core/config.ts";
import type { SubAgentInfo } from "../../src/subagents/types.ts";
import type { OutgoingMessage } from "../../src/channels/types.ts";

/**
 * The menu is only useful if the click lands in config.json and leaves the chat alone. These go
 * through the real channel handlers because the target rides inside callback_data, and a stripped
 * or ignored target would silently redirect the write to the session.
 */

const LLM = {
  defaultProvider: "litellm",
  defaultModel: "mimo",
  providers: { litellm: { baseUrl: "https://litellm.test/v1" }, anthropic: { type: "claude-sdk" as const } },
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
    telegram: createTelegramCommandHandler(deps),
    telegramCb: createTelegramCallbackHandler(deps),
    matrix: createMatrixCommandHandler(deps),
    matrixCb: createMatrixActionHandler(deps),
  };
}

async function writeConfigFile(): Promise<void> {
  await mkdir(dirname(CONFIG_PATH), { recursive: true });
  await writeFile(CONFIG_PATH, `${JSON.stringify({ whitelist: ["u1"], channels: {}, llm: LLM, agents: {} }, null, 2)}\n`);
}

async function readConfigFile(): Promise<Record<string, any>> {
  return JSON.parse(await readFile(CONFIG_PATH, "utf-8"));
}

/** The action behind the button for a given model label, as the channel rendered it. */
function actionFor(menu: OutgoingMessage, label: string): string {
  const button = (menu.buttons ?? []).find((b) => b.label.includes(label));
  if (!button) throw new Error(`no button for ${label} in ${JSON.stringify(menu.buttons)}`);
  return button.action;
}

afterEach(async () => {
  await rm(CONFIG_PATH, { force: true });
});

describe("both channels", () => {
  test("/model <agent> opens a menu whose buttons carry the agent target", async () => {
    const cfg = config();
    const h = harness(cfg);
    for (const menu of [
      (await h.telegram("c1", "u1", "dm", "model", "research")) as OutgoingMessage,
      (await h.matrix("!r:t", "u1", "dm", "model", "research")) as OutgoingMessage,
    ]) {
      expect(menu.text).toContain("research");
      expect(menu.text).toContain("Context: 262k");
      // A code, not a letter: agent names are open now, so the suffix is a hash of the name. What
      // matters is that it survives the round trip and resolves back to the same agent.
      const action = actionFor(menu, "Opus");
      expect(action).toMatch(/@[a-z0-9]{1,4}$/);
      expect(h.modelPicker.parseCallbackAction(action)).toMatchObject({ target: "research" });
    }
  });

  test("a plain /model <model> is untouched and still changes only the session", async () => {
    const cfg = config();
    const h = harness(cfg);
    await writeConfigFile();
    const reply = await h.telegram("c1", "u1", "dm", "model", "opus");
    expect(String(reply)).toContain("Model changed");
    expect((await readConfigFile())["agents"]).toEqual({});
  });

  test("clicking a model in an agent menu writes config and leaves the session alone", async () => {
    const cfg = config();
    const h = harness(cfg);
    await writeConfigFile();

    const menu = (await h.telegram("c1", "u1", "dm", "model", "research")) as OutgoingMessage;
    const result = await h.telegramCb({
      chatId: "c1", userId: "u1", chatType: "dm", data: actionFor(menu, "Opus"),
    });

    expect(result?.text).toContain("research");
    expect((await readConfigFile())["agents"]["research"]["llm"])
      .toEqual({ defaultModel: "opus", defaultProvider: "anthropic" });
    // The chat the owner was sitting in must not have moved.
    expect((await h.sessionManager.peek("telegram/dm/u1"))?.modelOverride).toBeUndefined();
  });

  test("the same click through the Matrix action handler has the same effect", async () => {
    const cfg = config();
    const h = harness(cfg);
    await writeConfigFile();

    const menu = (await h.matrix("!r:t", "u1", "dm", "model", "cron")) as OutgoingMessage;
    const result = await h.matrixCb({
      chatId: "!r:t", userId: "u1", chatType: "dm", data: actionFor(menu, "Opus"), messageId: "$e1",
    });

    expect(result?.text).toContain("cron");
    expect((await readConfigFile())["agents"]["cron"]["llm"]["defaultModel"]).toBe("opus");
  });

  test("a live sub-agent name reaches its type's config entry", async () => {
    const cfg = config();
    const h = harness(cfg);
    await writeConfigFile();
    const reply = await h.telegram("c1", "u1", "dm", "model", "subagent/digger-c3d4 opus");
    expect(String(reply)).toContain("research");
    expect((await readConfigFile())["agents"]["research"]["llm"]["defaultModel"]).toBe("opus");
  });

  test("in a group the command refuses and writes nothing", async () => {
    const cfg = config();
    const h = harness(cfg);
    await writeConfigFile();
    const reply = await h.telegram("c1", "u1", "group", "model", "research opus");
    expect(String(reply)).toContain("message privé");
    expect((await readConfigFile())["agents"]).toEqual({});
  });
});
