import { describe, test, expect, afterEach } from "bun:test";
import { readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  handleAgentModelCommand,
  applyAgentModel,
  applyAgentContext,
  resolveAgentTarget,
  currentAgentModel,
  AGENT_MODEL_DM_ONLY,
} from "../../src/channels/agent-model-commands.ts";
import { ModelPicker } from "../../src/channels/model-picker.ts";
import { CONFIG_PATH, parseConfig, resolveAgentLlm, type MyClawConfig } from "../../src/core/config.ts";
import type { SubAgentInfo } from "../../src/subagents/types.ts";
import { resolveContextWindow } from "../../src/llm/context-window.ts";

const INSTANCES: SubAgentInfo[] = [
  { id: "subagent/deploy-a1b2", displayName: "deploy", type: "general", messageCount: 3, status: "idle", visibility: "global", createdAt: "2026-01-01T00:00:00.000Z" },
  { id: "subagent/digger-c3d4", displayName: "digger", type: "research", messageCount: 9, status: "running", visibility: "global", createdAt: "2026-01-01T00:00:00.000Z" },
];

const listSubAgents = async (): Promise<SubAgentInfo[]> => INSTANCES;

/** The file on disk is the only thing that matters here: the live object is not the config. */
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

function picker(): ModelPicker {
  const p = new ModelPicker([]);
  p.syncFromConfig(FILE.llm as never);
  return p;
}

function config(): MyClawConfig {
  return JSON.parse(JSON.stringify(FILE)) as MyClawConfig;
}

/** The agents a real boot would carry: the two shipped built-ins. */
const listAgents = (): string[] => ["general", "research"];

function deps(over?: Partial<Parameters<typeof handleAgentModelCommand>[1]>) {
  return { config: config(), modelPicker: picker(), listSubAgents, listAgents, isDm: true, ...over };
}

afterEach(async () => {
  await rm(CONFIG_PATH, { force: true });
});

describe("resolveAgentTarget", () => {
  test("accepts the config names and the main alias", async () => {
    expect(await resolveAgentTarget("orchestrator", listSubAgents, listAgents)).toBe("orchestrator");
    expect(await resolveAgentTarget("main", listSubAgents, listAgents)).toBe("orchestrator");
    expect(await resolveAgentTarget("RESEARCH", listSubAgents, listAgents)).toBe("research");
    expect(await resolveAgentTarget("cron", listSubAgents, listAgents)).toBe("cron");
  });

  test("a live sub-agent resolves to its type, since config has no per-instance section", async () => {
    expect(await resolveAgentTarget("subagent/digger-c3d4", listSubAgents, listAgents)).toBe("research");
    expect(await resolveAgentTarget("deploy", listSubAgents, listAgents)).toBe("general");
  });

  test("a model name is not an agent", async () => {
    expect(await resolveAgentTarget("opus", listSubAgents, listAgents)).toBeNull();
    expect(await resolveAgentTarget("", listSubAgents, listAgents)).toBeNull();
  });
});

describe("/model <agent>", () => {
  test("a non-agent first word falls through to the session behaviour", async () => {
    expect((await handleAgentModelCommand("opus", deps())).kind).toBe("not-an-agent");
    // The multi-word fuzzy form of the session command must keep working.
    expect((await handleAgentModelCommand("claude opus 5", deps())).kind).toBe("not-an-agent");
    expect((await handleAgentModelCommand("", deps())).kind).toBe("not-an-agent");
  });

  test("an agent alone opens a menu targeted at that agent", async () => {
    const out = await handleAgentModelCommand("research", deps());
    expect(out).toMatchObject({ kind: "menu", target: "research", currentModel: "mimo" });
  });

  test("quotes around the agent name are accepted", async () => {
    expect((await handleAgentModelCommand('"general"', deps())).kind).toBe("menu");
    expect((await handleAgentModelCommand("'cron' opus", deps())).kind).toBe("message");
  });

  test("outside a DM it refuses instead of writing config", async () => {
    await writeConfigFile();
    const out = await handleAgentModelCommand("general opus", deps({ isDm: false }));
    expect(out).toEqual({ kind: "message", text: AGENT_MODEL_DM_ONLY });
    expect((await readConfigFile())["agents"]["general"]).toBeUndefined();
  });

  test("an unknown model is rejected and nothing is written", async () => {
    await writeConfigFile();
    const out = await handleAgentModelCommand("general nope-9000", deps());
    expect(out.kind).toBe("message");
    expect((out as { text: string }).text).toContain("Modèle inconnu");
    expect((await readConfigFile())["agents"]["general"]).toBeUndefined();
  });
});

describe("writing the pin", () => {
  test("the model AND its provider land in config.json", async () => {
    await writeConfigFile();
    const text = await applyAgentModel("research", "opus", { config: config(), modelPicker: picker() });
    expect(text).toContain("research");

    const written = await readConfigFile();
    expect(written["agents"]["research"]["llm"]).toEqual({ defaultModel: "opus", defaultProvider: "anthropic" });
  });

  test("the rest of the file is left untouched", async () => {
    await writeConfigFile();
    await applyAgentModel("general", "opus", { config: config(), modelPicker: picker() });
    const written = await readConfigFile();
    expect(written["whitelist"]).toEqual(["u1"]);
    expect(written["llm"]["models"]).toHaveLength(2);
    expect(written["agents"]["orchestrator"]).toEqual({ maxIterations: 90 });
  });

  test("the runtime catalogue is never persisted into the file", async () => {
    await writeConfigFile();
    // A live config carries provider-discovered models the file must not gain.
    const live = config();
    (live.llm.models as unknown[]).push({ id: "discovered", label: "Discovered", provider: "anthropic" });
    const p = picker();
    p.syncFromConfig(live.llm);
    await applyAgentModel("general", "discovered", { config: live, modelPicker: p });

    const written = await readConfigFile();
    expect(written["llm"]["models"]).toHaveLength(2);
    expect(written["agents"]["general"]["llm"]["defaultProvider"]).toBe("anthropic");
  });

  test("a broken config on disk is reported, not overwritten", async () => {
    await writeConfigFile();
    await writeFile(CONFIG_PATH, '{ "llm": broken');
    const text = await applyAgentModel("general", "opus", { config: config(), modelPicker: picker() });
    expect(text).toContain("non parsable");
    expect(await readFile(CONFIG_PATH, "utf-8")).toBe('{ "llm": broken');
  });

  test("the written file parses back and the pin is what the agent resolves to", async () => {
    await writeConfigFile();
    await applyAgentModel("cron", "opus", { config: config(), modelPicker: picker() });
    // parseConfig is the real loader: proves the shape survives a restart, not just JSON.parse.
    const reloaded = parseConfig(await readFile(CONFIG_PATH, "utf-8"));
    expect(resolveAgentLlm(reloaded, "cron")).toEqual({ defaultModel: "opus", defaultProvider: "anthropic" });
    // Pinning cron must not move the orchestrator the owner talks to.
    expect(resolveAgentLlm(reloaded, "main")).toBeUndefined();
  });

  test("the reply names the previous model and the reload runs", async () => {
    await writeConfigFile();
    let reloaded = 0;
    const text = await applyAgentModel("general", "opus", {
      config: config(),
      modelPicker: picker(),
      reloadConfigNow: async () => { reloaded++; },
    });
    expect(reloaded).toBe(1);
    expect(text).toContain("défaut global");
    expect(text).toContain("Opus");
  });
});

describe("currentAgentModel", () => {
  test("reports the agent default when set, the global one otherwise", () => {
    const c = config();
    expect(currentAgentModel(c, "general")).toBe("mimo");
    c.agents.general = { llm: { defaultModel: "opus", defaultProvider: "anthropic" } };
    expect(currentAgentModel(c, "general")).toBe("opus");
    expect(currentAgentModel(c, "orchestrator")).toBe("mimo");
  });

  test("cron inherits the orchestrator's pin, general does not", () => {
    const c = config();
    c.agents.orchestrator = { llm: { defaultModel: "opus", defaultProvider: "anthropic" } };
    expect(currentAgentModel(c, "cron")).toBe("opus");
    expect(currentAgentModel(c, "general")).toBe("mimo");
  });
});

/**
 * Per-agent context ceiling. Each agent and sub-agent is set independently: a research agent
 * reading long documents and a cron job posting a one-liner do not want the same window.
 * See docs/context-window.md.
 */
describe("applyAgentContext", () => {
  afterEach(async () => {
    await rm(CONFIG_PATH, { force: true });
  });

  test("a ceiling is written under the agent, not globally", async () => {
    await writeConfigFile();
    const text = await applyAgentContext("research", 128_000, { config: config() });
    expect(text).toMatch(/128,000/);
    const written = await readConfigFile();
    expect(written["agents"]["research"]["context"]).toEqual({ cap: 128_000 });
    // The global policy is untouched, and so is every other agent.
    expect(written["context"]).toBeUndefined();
    expect(written["agents"]["orchestrator"]).toEqual({ maxIterations: 90 });
  });

  test("two agents hold different ceilings at once", async () => {
    await writeConfigFile();
    await applyAgentContext("research", 128_000, { config: config() });
    await applyAgentContext("cron", 64_000, { config: config() });
    const written = await readConfigFile();
    expect(written["agents"]["research"]["context"]).toEqual({ cap: 128_000 });
    expect(written["agents"]["cron"]["context"]).toEqual({ cap: 64_000 });
  });

  test("the full window is written as a zero, which is how config spells no ceiling", async () => {
    await writeConfigFile();
    const text = await applyAgentContext("general", "full", { config: config() });
    expect(text).toMatch(/complète/);
    const written = await readConfigFile();
    expect(written["agents"]["general"]["context"]).toEqual({ cap: 0 });
  });

  test("the written ceiling is what the resolver then applies to that agent alone", async () => {
    await writeConfigFile();
    await applyAgentContext("research", 128_000, { config: config() });
    const reloaded = parseConfig(JSON.stringify(await readConfigFile()));
    const window = (model: string, agent: "research" | "general") =>
      resolveContextWindow({ model, config: reloaded, declared: 1_000_000, agent }).effective;
    expect(window("m", "research")).toBe(128_000);
    // Anything not named keeps the standing policy.
    expect(window("m", "general")).toBe(512_000);
  });

  test("a failed write reports instead of pretending, and leaves no config behind", async () => {
    await rm(CONFIG_PATH, { force: true });
    const text = await applyAgentContext("research", 128_000, { config: config() });
    expect(text).toMatch(/Échec/);
  });
});
