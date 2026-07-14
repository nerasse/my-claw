import { describe, test, expect, afterEach } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startConfigWatcher } from "../../src/core/config-watcher.ts";
import { parseConfig, type MyClawConfig } from "../../src/core/config.ts";
import { ModelPicker } from "../../src/channels/model-picker.ts";
import { hooks } from "../../src/hooks/index.ts";

function initialConfig(): MyClawConfig {
  return {
    whitelist: ["u1"],
    blacklist: ["spawn"],
    channels: {
      telegram: { token: "tok-123", mode: "polling", historyLimit: 10, errorPolicy: "always" },
    },
    llm: {
      defaultProvider: "p",
      defaultModel: "model-a",
      providers: { p: { baseUrl: "https://api.example.com" } },
      models: [{ id: "model-a", label: "Model A", provider: "p" }],
      limit: { context: 1000, output: 100 },
    },
    agents: {},
    memory: { enabled: true, recallMaxEntries: 5 },
  };
}

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function waitForReload(timeoutMs = 3000): Promise<{ changed: string[]; rebootRequired: string[] }> {
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

describe("E2E config hot-reload", () => {
  test("editing config.json on disk hot-reloads LLM + whitelist + memory, recreates telegram on token change", async () => {
    const dir = await mkdtemp(join(tmpdir(), "myclaw-cfg-"));
    const file = join(dir, "config.json");
    cleanups.push(() => rm(dir, { recursive: true, force: true }));

    await writeFile(file, JSON.stringify(initialConfig(), null, 2));
    const config = parseConfig(await Bun.file(file).text());

    const picker = new ModelPicker(config.llm.models!.map((m) => ({ id: m.id, label: m.label })));
    let tgWhitelist: Set<string> | undefined;
    let recreatedTg = 0;
    const telegram = {
      setWhitelist: (s: Set<string>) => { tgWhitelist = s; },
      applyConfigReload: () => { /* behavioral-only reload path, unused here */ },
    };

    const llmRef = config.llm;
    const tgRef = config.channels.telegram;

    const stop = startConfigWatcher(
      config,
      {
        modelPicker: picker,
        getTelegram: () => telegram,
        normalizeMatrixUserId: (id) => id.toLowerCase(),
        recreateTelegram: () => { recreatedTg += 1; },
      },
      {
        path: file,
        read: async () => parseConfig(await Bun.file(file).text()),
        debounceMs: 20,
      },
    );
    cleanups.push(() => stop());

    const reloaded = waitForReload();

    // Mutate the file: hot fields + a recreate field (telegram.token) + a now-hot section (memory).
    const next = initialConfig();
    next.llm.defaultModel = "model-b";
    next.llm.models = [
      { id: "model-a", label: "Model A", provider: "p" },
      { id: "model-b", label: "Model B", provider: "p" },
    ];
    next.whitelist = ["u1", "@Bob:HS"];
    next.channels.telegram!.historyLimit = 42;
    next.channels.telegram!.token = "ROTATED";
    next.memory!.recallMaxEntries = 99;
    await writeFile(file, JSON.stringify(next, null, 2));

    const payload = await reloaded;

    // Hook payload classification.
    expect(payload.changed).toContain("llm");
    expect(payload.changed).toContain("whitelist");
    expect(payload.changed).toContain("memory");
    // A telegram identity change is a recreate, not a plain "changed" apply.
    expect(payload.changed).not.toContain("channels.telegram");

    // In-place mutation preserved object identity.
    expect(config.llm).toBe(llmRef);
    expect(config.channels.telegram).toBe(tgRef);

    // Hot fields applied.
    expect(config.llm.defaultModel).toBe("model-b");
    expect(picker.find("model-b")?.id).toBe("model-b");
    expect(tgWhitelist?.has("u1")).toBe(true);
    expect(tgWhitelist?.has("@Bob:HS")).toBe(true);

    // Telegram identity recreate: applied in place (token + behavioral) and the applier fired.
    expect(config.channels.telegram!.token).toBe("ROTATED");
    expect(config.channels.telegram!.historyLimit).toBe(42);
    expect(recreatedTg).toBe(1);
    // memory is now hot: recall knobs apply in place.
    expect(config.memory!.recallMaxEntries).toBe(99);
  });

  test("editing .env beside config.json triggers a reload cycle", async () => {
    const dir = await mkdtemp(join(tmpdir(), "myclaw-cfg-"));
    const file = join(dir, "config.json");
    cleanups.push(() => rm(dir, { recursive: true, force: true }));

    await writeFile(file, JSON.stringify(initialConfig(), null, 2));
    // The .env already exists in production; a rotation modifies it in place.
    const envFile = join(dir, ".env");
    await writeFile(envFile, "TOKEN=first\n");
    const config = parseConfig(await Bun.file(file).text());

    // read() is where loadEnv force-refreshes process.env; proving it runs on a bare
    // .env edit proves a secret rotation is picked up without touching config.json.
    let reads = 0;
    const stop = startConfigWatcher(config, {}, {
      path: file,
      read: async () => { reads += 1; return parseConfig(await Bun.file(file).text()); },
      debounceMs: 20,
    });
    cleanups.push(() => stop());

    await writeFile(envFile, "TOKEN=rotated\n");
    for (let i = 0; i < 50 && reads === 0; i++) await new Promise((r) => setTimeout(r, 20));
    expect(reads).toBeGreaterThan(0);
  });

  test("invalid JSON is skipped and the running config is preserved", async () => {
    const dir = await mkdtemp(join(tmpdir(), "myclaw-cfg-"));
    const file = join(dir, "config.json");
    cleanups.push(() => rm(dir, { recursive: true, force: true }));

    await writeFile(file, JSON.stringify(initialConfig(), null, 2));
    const config = parseConfig(await Bun.file(file).text());

    let reloadCount = 0;
    const handler = () => { reloadCount += 1; };
    hooks.on("config:reloaded", handler);
    cleanups.push(() => hooks.off("config:reloaded", handler));

    const stop = startConfigWatcher(config, {}, {
      path: file,
      read: async () => parseConfig(await Bun.file(file).text()),
      debounceMs: 20,
    });
    cleanups.push(() => stop());

    await writeFile(file, "{ this is not valid json ");
    await new Promise((r) => setTimeout(r, 200));

    expect(reloadCount).toBe(0);
    expect(config.llm.defaultModel).toBe("model-a");
  });
});
