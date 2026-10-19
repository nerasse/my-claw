import { describe, test, expect, afterEach } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CONFIG_PATH, MY_CLAW_DIR } from "../../src/core/config.ts";
import { previewProviderRename, renameProviderEverywhere } from "../../src/core/provider-rename.ts";
import { accountPath } from "../../src/llm/accounts-store.ts";

const CONFIG = {
  llm: {
    defaultProvider: "anthropic",
    providers: {
      litellm: { baseUrl: "https://litellm.test/v1" },
      anthropic: { type: "anthropic" },
    },
    models: [{ id: "mimo", label: "MiMo", provider: "litellm" }],
  },
  tags: { Cheap: { route: [{ model: "litellm/mimo" }] } },
  agents: { orchestrator: { llm: { defaultModel: "litellm/mimo" } } },
};

const SESSION_PINNED = join(MY_CLAW_DIR, "sessions", "my-claw-app", "thread", "neras", "t1", "meta.json");
const SESSION_OTHER = join(MY_CLAW_DIR, "sessions", "subagent", "run-x", "meta.json");
const CRON_FILE = join(MY_CLAW_DIR, "cron", "jobs.json");
const AGENT_DIR = join(MY_CLAW_DIR, "agents");
const AGENT_FILE = join(AGENT_DIR, "helper.md");

async function seed(): Promise<void> {
  await mkdir(dirname(CONFIG_PATH), { recursive: true });
  await writeFile(CONFIG_PATH, `${JSON.stringify(CONFIG, null, 2)}\n`);
  await mkdir(dirname(SESSION_PINNED), { recursive: true });
  await mkdir(dirname(SESSION_OTHER), { recursive: true });
  await writeFile(SESSION_PINNED, JSON.stringify({ modelOverride: "litellm/mimo", effortOverride: "high" }, null, 2));
  await writeFile(SESSION_OTHER, JSON.stringify({ modelOverride: "anthropic/a" }, null, 2));
  await mkdir(dirname(CRON_FILE), { recursive: true });
  await writeFile(CRON_FILE, JSON.stringify({ jobs: [{ id: "j1", model: "litellm/mimo" }, { id: "j2", model: "tag:Cheap" }] }, null, 2));
  await mkdir(AGENT_DIR, { recursive: true });
  await writeFile(AGENT_FILE, "---\ndescription: helper\nmodel: litellm/mimo\n---\nBody stays.\n");
}

const readJson = async (path: string): Promise<Record<string, any>> => JSON.parse(await readFile(path, "utf-8"));

afterEach(async () => {
  await rm(CONFIG_PATH, { force: true });
  await rm(join(MY_CLAW_DIR, "sessions"), { recursive: true, force: true });
  await rm(join(MY_CLAW_DIR, "cron"), { recursive: true, force: true });
  await rm(AGENT_DIR, { recursive: true, force: true });
  await rm(join(MY_CLAW_DIR, "accounts"), { recursive: true, force: true });
});

describe("previewProviderRename", () => {
  test("names every store a rename would touch, read-only", async () => {
    await seed();
    const refs = await previewProviderRename("litellm", "llm", [AGENT_DIR]);
    expect(refs.models).toEqual(["mimo"]);
    expect(refs.tags).toEqual(["Cheap"]);
    expect(refs.agents).toEqual(["orchestrator"]);
    expect(refs.sessions).toEqual(["my-claw-app/thread/neras/t1"]);
    expect(refs.cron).toEqual(["j1"]);
    expect(refs.files).toEqual([AGENT_FILE]);
    expect(refs.account).toBe(false);
    // Read-only: the config on disk is byte-identical after a preview.
    const file = await readJson(CONFIG_PATH);
    expect(Object.keys(file.llm.providers).sort()).toEqual(["anthropic", "litellm"]);
    expect((await readJson(SESSION_PINNED)).modelOverride).toBe("litellm/mimo");
  });
});

describe("renameProviderEverywhere", () => {
  test("rewrites config, sessions, cron, agent files, and moves the sign-in", async () => {
    await seed();
    await mkdir(join(MY_CLAW_DIR, "accounts"), { recursive: true });
    await writeFile(accountPath("litellm"), JSON.stringify({ token: "sk-litellm" }));

    const result = await renameProviderEverywhere("litellm", "llm", [AGENT_DIR]);
    expect(result.ok).toBe(true);

    const config = await readJson(CONFIG_PATH);
    expect(config.llm.providers.llm.baseUrl).toBe("https://litellm.test/v1");
    expect(config.llm.providers.litellm).toBeUndefined();
    expect(config.llm.models[0].provider).toBe("llm");
    expect(config.tags.Cheap.route[0].model).toBe("llm/mimo");
    expect(config.agents.orchestrator.llm.defaultModel).toBe("llm/mimo");

    const pinned = await readJson(SESSION_PINNED);
    expect(pinned.modelOverride).toBe("llm/mimo");
    // The rest of the meta is untouched: only the reference travels.
    expect(pinned.effortOverride).toBe("high");
    expect((await readJson(SESSION_OTHER)).modelOverride).toBe("anthropic/a");

    const cron = await readJson(CRON_FILE);
    expect(cron.jobs[0].model).toBe("llm/mimo");
    expect(cron.jobs[1].model).toBe("tag:Cheap");

    const agentFile = await readFile(AGENT_FILE, "utf-8");
    expect(agentFile).toContain("model: llm/mimo");
    expect(agentFile).toContain("Body stays.");

    // The sign-in followed its key; the old file is gone.
    expect(JSON.parse(await readFile(accountPath("llm"), "utf-8")).token).toBe("sk-litellm");
    await expect(readFile(accountPath("litellm"), "utf-8")).rejects.toThrow();
  });

  test("a refused rename touches nothing at all", async () => {
    await seed();
    const result = await renameProviderEverywhere("litellm", "anthropic", [AGENT_DIR]);
    expect(result.ok).toBe(false);
    const config = await readJson(CONFIG_PATH);
    expect(Object.keys(config.llm.providers).sort()).toEqual(["anthropic", "litellm"]);
    expect((await readJson(SESSION_PINNED)).modelOverride).toBe("litellm/mimo");
  });

  test("an account file already sitting on the target refuses before the config moves", async () => {
    await seed();
    await mkdir(join(MY_CLAW_DIR, "accounts"), { recursive: true });
    await writeFile(accountPath("litellm"), JSON.stringify({ token: "sk-litellm" }));
    await writeFile(accountPath("llm"), JSON.stringify({ token: "sk-other" }));
    const result = await renameProviderEverywhere("litellm", "llm", [AGENT_DIR]);
    expect(result.ok).toBe(false);
    const config = await readJson(CONFIG_PATH);
    expect(config.llm.providers.litellm).toBeDefined();
  });
});
