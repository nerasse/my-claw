import { describe, test, expect, afterEach } from "bun:test";
import { readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  setAgentModel,
  setDefaultModel,
  setDefaultEffort,
  clearAgentModel,
} from "../../src/core/config-edit.ts";
import { CONFIG_PATH, parseConfig, resolveAgentLlm, type MyClawConfig } from "../../src/core/config.ts";

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
    const reloaded = parseConfig(await readFile(CONFIG_PATH, "utf-8")) as MyClawConfig;
    expect(reloaded.llm.defaultModel).toBe("opus");
    expect(reloaded.agents?.cron?.llm?.defaultModel).toBe("opus");
  });
});
