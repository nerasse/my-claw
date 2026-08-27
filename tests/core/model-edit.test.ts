import { describe, test, expect, afterEach } from "bun:test";
import { readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { upsertModel, removeModel } from "../../src/core/config-edit.ts";
import { CONFIG_PATH } from "../../src/core/config.ts";

const FILE = {
  llm: {
    defaultProvider: "litellm",
    defaultModel: "litellm/local",
    providers: {
      litellm: { baseUrl: "https://litellm.test/v1", apiKeyEnv: "LITELLM_API_KEY", discover: true },
      anthropic: { type: "anthropic", group: "Claude" },
    },
    models: [{ id: "litellm/local", label: "Local", provider: "litellm" }],
  },
  channels: { telegram: { enabled: true } },
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

describe("upsertModel", () => {
  test("declares a model discovery does not know, and leaves the rest of the file alone", async () => {
    await writeConfigFile();
    const result = await upsertModel({
      id: "groq-whisper",
      label: "Whisper",
      provider: "litellm",
      vision: false,
      limit: { context: 32768, output: 8192 },
    });
    expect(result.ok).toBe(true);
    const file = await readConfigFile();
    expect(file.llm.models).toHaveLength(2);
    expect(file.llm.models[1]).toEqual({
      id: "groq-whisper",
      label: "Whisper",
      provider: "litellm",
      vision: false,
      limit: { context: 32768, output: 8192 },
    });
    expect(file.channels).toEqual({ telegram: { enabled: true } });
  });

  test("an id already declared is replaced, not appended", async () => {
    await writeConfigFile();
    await upsertModel({ id: "litellm/local", label: "Renamed", provider: "litellm" });
    const file = await readConfigFile();
    expect(file.llm.models).toHaveLength(1);
    expect(file.llm.models[0].label).toBe("Renamed");
  });

  test("only what was sent is stored, so the rest keeps following discovery", async () => {
    await writeConfigFile();
    // An owner pinning one window must not freeze a copy of everything else: the merge with
    // discovery is field-level, so an absent field means "whatever the provider says".
    await upsertModel({ id: "litellm/zai", provider: "litellm", limit: { context: 200000 } });
    const file = await readConfigFile();
    expect(file.llm.models[1]).toEqual({
      id: "litellm/zai",
      label: "litellm/zai",
      provider: "litellm",
      limit: { context: 200000 },
    });
  });

  test("writes the models array into a config that has none", async () => {
    await writeConfigFile({ llm: { providers: { litellm: { baseUrl: "https://litellm.test/v1" } } } });
    const result = await upsertModel({ id: "first", provider: "litellm" });
    expect(result.ok).toBe(true);
    expect((await readConfigFile()).llm.models).toEqual([{ id: "first", label: "first", provider: "litellm" }]);
  });

  test("refuses an id with whitespace or an endpoint pin", async () => {
    await writeConfigFile();
    for (const id of ["two words", "model@azure/eu", ""]) {
      const result = await upsertModel({ id, provider: "litellm" });
      expect(result.ok).toBe(false);
    }
    expect((await readConfigFile()).llm.models).toHaveLength(1);
  });

  test("refuses the tag: prefix, which addresses an alias and not a model", async () => {
    await writeConfigFile();
    const result = await upsertModel({ id: "tag:Default", provider: "litellm" });
    expect(result.ok).toBe(false);
  });

  test("refuses a provider that is not declared", async () => {
    await writeConfigFile();
    const result = await upsertModel({ id: "orphan", provider: "nowhere" });
    expect(result).toEqual({ ok: false, error: "Provider not declared: nowhere" });
  });

  test("refuses an id qualified with another provider than the one declared", async () => {
    await writeConfigFile();
    // `parseModelRef` reads the head of the id as the provider when one by that name exists, so
    // this entry would send every request to litellm while the file claims anthropic.
    const result = await upsertModel({ id: "litellm/foo", provider: "anthropic" });
    expect(result.ok).toBe(false);
  });

  test("refuses a window that is not a positive integer", async () => {
    await writeConfigFile();
    expect((await upsertModel({ id: "a", provider: "litellm", limit: { context: 0 } })).ok).toBe(false);
    expect((await upsertModel({ id: "a", provider: "litellm", limit: { output: -1 } })).ok).toBe(false);
    expect((await upsertModel({ id: "a", provider: "litellm", limit: { context: 1.5 } })).ok).toBe(false);
  });

  test("stores a request timeout, zero included", async () => {
    await writeConfigFile();
    expect((await upsertModel({ id: "slow", provider: "litellm", timeoutMs: 900_000 })).ok).toBe(true);
    expect((await readConfigFile()).llm.models[1].timeoutMs).toBe(900_000);

    // The value the feature exists for: `0` removes the wall, so a truthiness check anywhere on
    // the write path would drop it and silently restore the transport default.
    expect((await upsertModel({ id: "slow", provider: "litellm", timeoutMs: 0 })).ok).toBe(true);
    expect((await readConfigFile()).llm.models[1].timeoutMs).toBe(0);
  });

  test("refuses a timeout that is not zero or a positive integer", async () => {
    await writeConfigFile();
    expect((await upsertModel({ id: "a", provider: "litellm", timeoutMs: -1 })).ok).toBe(false);
    expect((await upsertModel({ id: "a", provider: "litellm", timeoutMs: 1.5 })).ok).toBe(false);
    expect((await upsertModel({ id: "a", provider: "litellm", timeoutMs: Number.NaN })).ok).toBe(false);
    expect((await readConfigFile()).llm.models).toHaveLength(1);
  });

  test("an absent timeout is not written, so the model keeps following the default", async () => {
    await writeConfigFile();
    await upsertModel({ id: "plain", provider: "litellm" });
    expect(Object.keys((await readConfigFile()).llm.models[1])).not.toContain("timeoutMs");
  });

  test("refuses an effort rung the API does not publish", async () => {
    await writeConfigFile();
    const result = await upsertModel({
      id: "a",
      provider: "litellm",
      supportedEffortLevels: ["low", "ultra" as never],
    });
    expect(result).toEqual({ ok: false, error: "Unknown effort level: ultra" });
  });

  test("refuses half a thinking capability", async () => {
    await writeConfigFile();
    const result = await upsertModel({
      id: "a",
      provider: "litellm",
      thinkingTypes: { adaptive: true } as never,
    });
    expect(result.ok).toBe(false);
  });

  test("refuses to touch an unparsable file", async () => {
    await mkdir(dirname(CONFIG_PATH), { recursive: true });
    await writeFile(CONFIG_PATH, "{ broken");
    const result = await upsertModel({ id: "a", provider: "litellm" });
    expect(result.ok).toBe(false);
    expect(await readFile(CONFIG_PATH, "utf-8")).toBe("{ broken");
  });
});

describe("removeModel", () => {
  test("deletes the declaration and keeps the array", async () => {
    await writeConfigFile();
    const result = await removeModel("litellm/local");
    expect(result.ok).toBe(true);
    expect((await readConfigFile()).llm.models).toEqual([]);
  });

  test("an unknown id is a refusal, not a silent success", async () => {
    await writeConfigFile();
    // "Nothing to delete" and "deleted" look identical from the app, and the difference is what
    // tells the owner the id came from discovery rather than from their file.
    const result = await removeModel("never-declared");
    expect(result).toEqual({ ok: false, error: 'No model declared with the id "never-declared"' });
  });
});
