import { describe, test, expect, afterEach } from "bun:test";
import { mkdtemp, writeFile, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startConfigWatcher } from "../../src/core/config-watcher.ts";
import { parseConfig, resolveScanPolicy, MY_CLAW_DIR, type MyClawConfig } from "../../src/core/config.ts";
import { artifactId, setQuarantine, clearQuarantine, contentSha } from "../../src/core/config-store.ts";
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

/**
 * Event-driven wait: resolves the instant the caller signals, instead of polling for a fixed
 * budget. Polling made the outcome depend on how fast the machine delivers fs.watch events,
 * which fails on a loaded CI runner while passing locally.
 */
function signalGate(label: string, timeoutMs = 10_000): { fired: () => void; done: Promise<void> } {
  let fire!: () => void;
  const inner = new Promise<void>((resolve) => { fire = resolve; });
  const done = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs);
    void inner.then(() => { clearTimeout(timer); resolve(); });
  });
  return { fired: fire, done };
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

    const watcher = startConfigWatcher(
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
    cleanups.push(() => watcher.stop());

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
    const gate = signalGate("config read triggered by the .env edit");
    const watcher = startConfigWatcher(config, {}, {
      path: file,
      read: async () => { reads += 1; gate.fired(); return parseConfig(await Bun.file(file).text()); },
      debounceMs: 20,
    });
    cleanups.push(() => watcher.stop());

    // Bun's fs.watch is not active when watch() returns: it needs an event-loop turn to
    // register, and under load a single write can beat it and be lost outright (measured:
    // with no yield at all, 30/30 events lost). Re-touching until the watcher reacts makes
    // the test independent of that registration latency rather than betting on one write.
    await writeFile(envFile, "TOKEN=rotated\n");
    const retouch = setInterval(() => { void writeFile(envFile, `TOKEN=rotated-${Date.now()}\n`).catch(() => {}); }, 100);
    cleanups.push(() => clearInterval(retouch));
    try {
      await gate.done;
    } finally {
      clearInterval(retouch);
    }
    expect(reads).toBeGreaterThan(0);
  }, 15_000);

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

    const watcher = startConfigWatcher(config, {}, {
      path: file,
      read: async () => parseConfig(await Bun.file(file).text()),
      debounceMs: 20,
    });
    cleanups.push(() => watcher.stop());

    await writeFile(file, "{ this is not valid json ");
    await new Promise((r) => setTimeout(r, 200));

    expect(reloadCount).toBe(0);
    expect(config.llm.defaultModel).toBe("model-a");
  });

  test("a rejected reload is archived so the evidence survives the fix", async () => {
    const dir = await mkdtemp(join(tmpdir(), "myclaw-cfg-"));
    const file = join(dir, "config.json");
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    cleanups.push(() => rm(join(MY_CLAW_DIR, "backups"), { recursive: true, force: true }));

    await writeFile(file, JSON.stringify(initialConfig(), null, 2));
    const config = parseConfig(await Bun.file(file).text());

    // The broken content is written before the watcher exists, so fs.watch never sees it: the
    // explicit reloadNow below is the only attempt, and the archive count is therefore exact.
    // Watching first would let the debounced auto-reload archive it too and yield 2 files.
    await writeFile(file, "{ broken beyond repair");
    const watcher = startConfigWatcher(config, {}, {
      path: file,
      read: async () => parseConfig(await Bun.file(file).text()),
      debounceMs: 20,
    });
    cleanups.push(() => watcher.stop());

    const result = await watcher.reloadNow();
    expect(result.changed).toEqual([]);

    const rejectedDir = join(MY_CLAW_DIR, "backups", artifactId(file), "rejected");
    const files = await readdir(rejectedDir);
    expect(files).toHaveLength(1);
    expect(await readFile(join(rejectedDir, files[0]!), "utf-8")).toBe("{ broken beyond repair");
    // The owner will fix the file in seconds; the archive is what still explains the skip.
    expect(config.llm.defaultModel).toBe("model-a");
  });

  test("antiInjection is hot-reloaded in place so a run picks up the new sanction", async () => {
    const dir = await mkdtemp(join(tmpdir(), "myclaw-cfg-"));
    const file = join(dir, "config.json");
    cleanups.push(() => rm(dir, { recursive: true, force: true }));

    await writeFile(file, JSON.stringify(initialConfig(), null, 2));
    const config = parseConfig(await Bun.file(file).text());
    expect(resolveScanPolicy(config)).toEqual({ enabled: true, ownerSanction: "annotate" });

    const next = initialConfig();
    next.antiInjection = { ownerSanction: "block" };
    await writeFile(file, JSON.stringify(next, null, 2));
    const watcher = startConfigWatcher(config, {}, {
      path: file,
      read: async () => parseConfig(await Bun.file(file).text()),
      debounceMs: 20,
    });
    cleanups.push(() => watcher.stop());

    const result = await watcher.reloadNow();
    expect(result.changed).toContain("antiInjection");
    // Every run resolves the policy from the same live object, so mutating it in place is what
    // makes the change take effect without a restart.
    expect(resolveScanPolicy(config)).toEqual({ enabled: true, ownerSanction: "block" });
  });

  test("a quarantined content cannot come back through a save", async () => {
    const dir = await mkdtemp(join(tmpdir(), "myclaw-cfg-"));
    const file = join(dir, "config.json");
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    cleanups.push(() => rm(join(MY_CLAW_DIR, "backups"), { recursive: true, force: true }));
    cleanups.push(() => clearQuarantine());

    await writeFile(file, JSON.stringify(initialConfig(), null, 2));
    const config = parseConfig(await Bun.file(file).text());
    const watcher = startConfigWatcher(config, {}, {
      path: file,
      read: async () => parseConfig(await Bun.file(file).text()),
      debounceMs: 20,
    });
    cleanups.push(() => watcher.stop());

    const bad = initialConfig();
    bad.llm.defaultModel = "model-quarantined";
    const raw = JSON.stringify(bad, null, 2);
    // Quarantine first: writing the file wakes the watcher, whose own debounced reload would race
    // setQuarantine's disk write and apply the bad config before the marker exists.
    await setQuarantine(contentSha(raw), "aucun canal actif");
    await writeFile(file, raw);

    // It parses, so nothing but the marker stands between it and the live config; re-applying it
    // would undo the revert that just brought the channel back.
    const result = await watcher.reloadNow();
    expect(result.changed).toEqual([]);
    expect(config.llm.defaultModel).toBe("model-a");
  });

  test("a throw while applying is contained instead of killing the process", async () => {
    const dir = await mkdtemp(join(tmpdir(), "myclaw-cfg-"));
    const file = join(dir, "config.json");
    cleanups.push(() => rm(dir, { recursive: true, force: true }));

    await writeFile(file, JSON.stringify(initialConfig(), null, 2));
    const config = parseConfig(await Bun.file(file).text());
    // Freezing whitelist makes the in-place splice throw from inside applyHotReload, which used to
    // sit outside both guards: the rejection reached index.ts and exited the process.
    Object.freeze(config.whitelist);

    let reloads = 0;
    const handler = () => { reloads += 1; };
    hooks.on("config:reloaded", handler);
    cleanups.push(() => hooks.off("config:reloaded", handler));

    const watcher = startConfigWatcher(config, {}, {
      path: file,
      read: async () => parseConfig(await Bun.file(file).text()),
      debounceMs: 20,
    });
    cleanups.push(() => watcher.stop());

    const next = initialConfig();
    next.whitelist = ["someone-else"];
    await writeFile(file, JSON.stringify(next, null, 2));

    const result = await watcher.reloadNow();
    expect(result.changed).toEqual([]);
    expect(reloads).toBe(0);
  });
});
