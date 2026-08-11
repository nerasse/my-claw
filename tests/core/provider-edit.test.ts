import { describe, test, expect, afterEach } from "bun:test";
import { readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  upsertProvider,
  removeProvider,
  renameProvider,
  repointEnvKey,
} from "../../src/core/config-edit.ts";
import { CONFIG_PATH, MY_CLAW_DIR } from "../../src/core/config.ts";
import { envKeys, setEnvValue, renameEnvKey, removeEnvKey } from "../../src/core/env-edit.ts";

const ENV_PATH = join(MY_CLAW_DIR, ".env");

const FILE = {
  llm: {
    defaultProvider: "litellm",
    providers: {
      litellm: { baseUrl: "https://litellm.test/v1", apiKeyEnv: "LITELLM_API_KEY", discover: true },
      anthropic: { type: "claude-sdk", group: "Claude (abo)" },
    },
    models: [
      { id: "mimo", label: "MiMo", provider: "litellm" },
      { id: "opus", label: "Opus", provider: "anthropic" },
    ],
  },
};

async function writeConfigFile(data: unknown = FILE): Promise<void> {
  await mkdir(dirname(CONFIG_PATH), { recursive: true });
  await writeFile(CONFIG_PATH, `${JSON.stringify(data, null, 2)}\n`);
}

async function readConfigFile(): Promise<Record<string, any>> {
  return JSON.parse(await readFile(CONFIG_PATH, "utf-8"));
}

async function writeEnv(text: string): Promise<void> {
  await mkdir(dirname(ENV_PATH), { recursive: true });
  await writeFile(ENV_PATH, text);
}

afterEach(async () => {
  await rm(CONFIG_PATH, { force: true });
  await rm(ENV_PATH, { force: true });
  delete process.env.LITELLM_API_KEY;
  delete process.env.NEW_KEY;
  delete process.env.SHARED_KEY;
  delete process.env.OLD_KEY;
});

describe("upsertProvider", () => {
  test("creates a provider and preserves the rest of the file", async () => {
    await writeConfigFile();
    const result = await upsertProvider("groq", { type: "openai", baseUrl: "https://groq.test/v1", discover: true });
    expect(result.ok).toBe(true);
    const file = await readConfigFile();
    expect(file.llm.providers.groq).toEqual({ type: "openai", baseUrl: "https://groq.test/v1", discover: true });
    expect(file.llm.models).toHaveLength(2);
    expect(file.llm.defaultProvider).toBe("litellm");
  });

  test("merges into an existing provider, dropping empty optional fields", async () => {
    await writeConfigFile();
    await upsertProvider("litellm", { group: "LiteLLM", discover: false, pricingProvider: "" });
    const file = await readConfigFile();
    expect(file.llm.providers.litellm).toEqual({
      baseUrl: "https://litellm.test/v1",
      apiKeyEnv: "LITELLM_API_KEY",
      discover: false,
      group: "LiteLLM",
    });
  });

  test("refuses the reserved tags key", async () => {
    await writeConfigFile();
    const result = await upsertProvider("tags", { type: "openai", baseUrl: "https://x.test/v1" });
    expect(result.ok).toBe(false);
    expect(String(result.ok === false && result.error)).toContain("reserved");
  });

  test("refuses an invalid key and an invalid type", async () => {
    await writeConfigFile();
    expect((await upsertProvider("Bad Key!", {})).ok).toBe(false);
    expect((await upsertProvider("ok", { type: "gemini" as never })).ok).toBe(false);
  });

  test("openai needs a baseUrl, sdk types reject one and a key env", async () => {
    await writeConfigFile();
    expect((await upsertProvider("naked", { type: "openai" })).ok).toBe(false);
    expect((await upsertProvider("sdk", { type: "claude-sdk", baseUrl: "https://x" })).ok).toBe(false);
    expect((await upsertProvider("sdk", { type: "codex", apiKeyEnv: "CODEX_KEY" })).ok).toBe(false);
    const ok = await upsertProvider("sdk", { type: "claude-sdk", group: "Claude (abo)" });
    expect(ok.ok).toBe(true);
  });
});

describe("removeProvider", () => {
  test("removes the entry and the whole providers section when empty", async () => {
    await writeConfigFile({
      llm: {
        defaultProvider: "other",
        providers: { solo: { baseUrl: "https://solo.test/v1" } },
        models: [],
      },
    });
    const result = await removeProvider("solo");
    expect(result.ok).toBe(true);
    const file = await readConfigFile();
    expect(file.llm.providers).toBeUndefined();
    expect(file.llm.defaultProvider).toBe("other");
  });

  test("refuses while it is the default provider", async () => {
    await writeConfigFile();
    const result = await removeProvider("litellm");
    expect(result.ok).toBe(false);
    expect(String(result.ok === false && result.error)).toContain("llm.defaultProvider");
  });

  test("refuses while curated models still reference it", async () => {
    await writeConfigFile({ ...FILE, llm: { ...FILE.llm, defaultProvider: "anthropic" } });
    const result = await removeProvider("litellm");
    expect(result.ok).toBe(false);
    expect(String(result.ok === false && result.error)).toContain("curated model mimo");
  });

  test("refuses an undeclared provider", async () => {
    await writeConfigFile();
    expect((await removeProvider("ghost")).ok).toBe(false);
  });
});

describe("renameProvider", () => {
  test("renames the entry and every reference in the same write", async () => {
    await writeConfigFile();
    const result = await renameProvider("litellm", "llm");
    expect(result.ok).toBe(true);
    const file = await readConfigFile();
    expect(file.llm.providers.llm.baseUrl).toBe("https://litellm.test/v1");
    expect(file.llm.providers.litellm).toBeUndefined();
    expect(file.llm.defaultProvider).toBe("llm");
    expect(file.llm.models.find((m: any) => m.id === "mimo").provider).toBe("llm");
  });

  test("refuses onto an existing key and the reserved tags key", async () => {
    await writeConfigFile();
    expect((await renameProvider("litellm", "anthropic")).ok).toBe(false);
    expect((await renameProvider("litellm", "tags")).ok).toBe(false);
  });
});

describe("env-edit", () => {
  test("envKeys lists names in file order, never values", async () => {
    await writeEnv("# a comment\nA_KEY=secret-one\nB_KEY=secret-two\n");
    expect(await envKeys()).toEqual(["A_KEY", "B_KEY"]);
  });

  test("setEnvValue replaces in place, keeping comments and order", async () => {
    await writeEnv("# first line\nA_KEY=old\nB_KEY=two\n");
    await setEnvValue("B_KEY", "changed");
    const text = await readFile(ENV_PATH, "utf-8");
    expect(text).toBe("# first line\nA_KEY=old\nB_KEY=changed\n");
  });

  test("setEnvValue appends a new key at the end", async () => {
    await writeEnv("A_KEY=one\n");
    await setEnvValue("B_KEY", "two");
    expect(await readFile(ENV_PATH, "utf-8")).toBe("A_KEY=one\nB_KEY=two\n");
    expect(process.env.B_KEY).toBe("two");
  });

  test("renameEnvKey keeps the value and drops the old name from the process", async () => {
    await writeEnv("A_KEY=secret-value\n");
    process.env.A_KEY = "secret-value";
    const result = await renameEnvKey("A_KEY", "NEW_KEY");
    expect(result.ok).toBe(true);
    expect(await readFile(ENV_PATH, "utf-8")).toBe("NEW_KEY=secret-value\n");
    expect(process.env.NEW_KEY).toBe("secret-value");
    expect(process.env.A_KEY).toBeUndefined();
  });

  test("renameEnvKey refuses a name that is not in the file", async () => {
    await writeEnv("A_KEY=x\n");
    expect((await renameEnvKey("GHOST", "NEW_KEY")).ok).toBe(false);
  });

  test("renameEnvKey refuses a target that already has a line", async () => {
    await writeEnv("A_KEY=x\nB_KEY=y\n");
    const result = await renameEnvKey("A_KEY", "B_KEY");
    expect(result.ok).toBe(false);
    expect(await readFile(ENV_PATH, "utf-8")).toBe("A_KEY=x\nB_KEY=y\n");
  });

  test("removeEnvKey drops the line and the process entry", async () => {
    await writeEnv("A_KEY=x\nB_KEY=y\n");
    process.env.B_KEY = "y";
    await removeEnvKey("B_KEY");
    expect(await readFile(ENV_PATH, "utf-8")).toBe("A_KEY=x\n");
    expect(process.env.B_KEY).toBeUndefined();
  });
});

describe("repointEnvKey", () => {
  test("repoints every provider that read the old name", async () => {
    await writeConfigFile({ ...FILE, llm: { ...FILE.llm, providers: { ...FILE.llm.providers, secondary: { baseUrl: "https://s.test/v1", apiKeyEnv: "LITELLM_API_KEY" } } } });
    const result = await repointEnvKey("LITELLM_API_KEY", "SHARED_KEY");
    expect(result.ok).toBe(true);
    const file = await readConfigFile();
    expect(file.llm.providers.litellm.apiKeyEnv).toBe("SHARED_KEY");
    expect(file.llm.providers.secondary.apiKeyEnv).toBe("SHARED_KEY");
  });

  test("is a no-op when nothing reads the name", async () => {
    await writeConfigFile();
    expect((await repointEnvKey("GHOST_KEY", "NEW_KEY")).ok).toBe(true);
  });
});
