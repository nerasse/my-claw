import { describe, expect, test } from "bun:test";
import type { MyClawConfig } from "../src/core/config.ts";
import {
  NoRunnableModelError,
  UnknownModelError,
  availabilityOf,
  overrideForPick,
  resolveRunModel,
  runnableModels,
  type AvailabilityWorld,
} from "../src/llm/run-model.ts";
import { chatModel } from "../src/llm/chat-model.ts";
import { setAvailabilityWorld, resetAvailabilityWorld } from "../src/llm/world.ts";

/** Everything reachable, nothing stale: the baseline the other worlds deviate from. */
function world(over: Partial<AvailabilityWorld> = {}): AvailabilityWorld {
  return {
    answered: () => false,
    listedBy: () => new Set(),
    hasEnv: () => true,
    claudeAuth: true,
    codexAuth: true,
    ...over,
  };
}

function config(over: Partial<MyClawConfig> = {}): MyClawConfig {
  return {
    llm: {
      defaultProvider: "anthropic",
      defaultModel: "claude-sonnet-5",
      providers: {
        anthropic: { type: "claude-sdk", discover: true },
        chatgpt: { type: "codex", discover: true },
        litellm: { baseUrl: "https://litellm.example/v1", apiKeyEnv: "LITELLM_API_KEY", discover: true },
      },
      models: [
        { id: "claude-sonnet-5", provider: "anthropic" },
        { id: "claude-opus-5", provider: "anthropic" },
        { id: "gpt-5.6-sol", provider: "chatgpt" },
        { id: "mimo-v2.5-pro", provider: "litellm" },
        { id: "qwen", provider: "litellm" },
      ],
    },
    ...over,
  } as MyClawConfig;
}

describe("the chain", () => {
  test("the chat's own pick wins over the agent pin and the global default", () => {
    const c = config({ agents: { orchestrator: { llm: { defaultModel: "claude-opus-5" } } } });
    const run = resolveRunModel(c, { agent: "main", sessionModel: "qwen" }, world());
    expect(run.model).toBe("qwen");
    expect(run.source).toBe("session");
  });

  test("the agent pin wins over the global default, and says where it lives", () => {
    const c = config({ agents: { orchestrator: { llm: { defaultModel: "claude-opus-5" } } } });
    const run = resolveRunModel(c, { agent: "main" }, world());
    expect(run.model).toBe("claude-opus-5");
    expect(run.source).toBe("agent");
  });

  test("the agent file's model sits under the config entry", () => {
    const withEntry = config({ agents: { general: { llm: { defaultModel: "claude-opus-5" } } } });
    expect(resolveRunModel(withEntry, { agent: "general", fileModel: "qwen" }, world()).source).toBe("agent");
    const noEntry = config();
    const run = resolveRunModel(noEntry, { agent: "general", fileModel: "qwen" }, world());
    expect(run.model).toBe("qwen");
    expect(run.source).toBe("agent-file");
  });

  test("cron inherits the orchestrator's pin, and the origin names where it really lives", () => {
    const c = config({
      agents: { orchestrator: { llm: { defaultModel: "mimo-v2.5-pro" } } },
      llm: { ...config().llm, defaultModel: "qwen" },
    });
    // Available: cron runs the orchestrator's pin, since only cron inherits it.
    expect(resolveRunModel(c, { agent: "cron" }, world()).model).toBe("mimo-v2.5-pro");
    // Unavailable: the origin must point at the orchestrator's entry, not at an empty cron one.
    const stale = world({ answered: (p) => p === "litellm", listedBy: () => new Set(["qwen"]) });
    const run = resolveRunModel(c, { agent: "cron" }, stale);
    expect(run.model).toBe("qwen");
    expect(run.skipped[0]?.origin).toBe("config.agents.orchestrator.llm.defaultModel");
  });

  test("a sub-agent with no entry of its own takes the global default, not the orchestrator's pin", () => {
    const c = config({ agents: { orchestrator: { llm: { defaultModel: "claude-opus-5" } } } });
    const run = resolveRunModel(c, { agent: "general" }, world());
    expect(run.model).toBe("claude-sonnet-5");
    expect(run.source).toBe("global");
  });

  test("the incident: picking the model that equals the global default still runs it", () => {
    // Global default A, agent pin B, the chat picks A. The old rule cleared the override on
    // equality with the global default, handing the run to B -- a model nobody chose.
    const c = config({ agents: { orchestrator: { llm: { defaultModel: "mimo-v2.5-pro" } } } });
    const run = resolveRunModel(c, { agent: "main", sessionModel: "claude-sonnet-5" }, world());
    expect(run.model).toBe("claude-sonnet-5");
    expect(run.source).toBe("session");
  });
});

describe("writing a pick", () => {
  test("picking the global default on a chat that inherits a pin pins it, and the display agrees", () => {
    // The incident, at the line that caused it. Global default A, orchestrator pinned to B, the
    // user picks A. The old rule (`pick === llm.defaultModel ? undefined : pick`) cleared the
    // override, so the run went to B while every screen said A -- for two days.
    const c = config({ agents: { orchestrator: { llm: { defaultModel: "claude-opus-5" } } } });
    const pin = overrideForPick(c, { agent: "main" }, "claude-sonnet-5", world());
    expect(pin).toBe("claude-sonnet-5");
    expect(resolveRunModel(c, { agent: "main", sessionModel: pin }, world()).model).toBe("claude-sonnet-5");
    // The display reads the installed world, not an argument: what every menu and status line does.
    setAvailabilityWorld(() => world());
    try {
      expect(chatModel(c, pin)).toBe("claude-sonnet-5");
      // And without the pick, the same surface says the pin -- which is the truth it used to hide.
      expect(chatModel(c, undefined)).toBe("claude-opus-5");
    } finally {
      resetAvailabilityWorld();
    }
  });

  test("picking what would run anyway clears the override instead of freezing it", () => {
    // Not cosmetic: a frozen override would keep this chat on B after the pin moves on.
    const c = config({ agents: { orchestrator: { llm: { defaultModel: "claude-opus-5" } } } });
    expect(overrideForPick(c, { agent: "main" }, "claude-opus-5", world())).toBeUndefined();
    // With no pin, that is the global default.
    expect(overrideForPick(config(), { agent: "main" }, "claude-sonnet-5", world())).toBeUndefined();
  });

  test("picking a tag that aliases the inherited model still pins the tag", () => {
    // A tag carries its own effort: dropping it as a no-op would drop that too.
    const c = config({ tags: { Slow: { model: "claude-sonnet-5", effort: "low" } } });
    expect(overrideForPick(c, { agent: "main" }, "tag:Slow", world())).toBe("tag:Slow");
  });
});

describe("the backend follows the resolved model", () => {
  test("each provider type routes to its own engine, never the default provider's", () => {
    const c = config();
    expect(resolveRunModel(c, { agent: "main", sessionModel: "claude-sonnet-5" }, world()).backend).toBe("claude-sdk");
    expect(resolveRunModel(c, { agent: "main", sessionModel: "gpt-5.6-sol" }, world()).backend).toBe("codex");
    expect(resolveRunModel(c, { agent: "main", sessionModel: "qwen" }, world()).backend).toBeUndefined();
  });

  test("an unknown id is refused, never sent to the default provider", () => {
    // The old resolver took `model?.provider ?? defaultProvider`, so an unlisted ChatGPT id went
    // to the Claude SDK: a silent misroute across vendors.
    expect(() => resolveRunModel(config(), { agent: "main", sessionModel: "gpt-9-unlisted" }, world())).toThrow(
      UnknownModelError,
    );
  });

  test("a config with no model list judges nothing: one provider, nothing to misroute to", () => {
    // The implicit-provider format has no `models` and no `providers`. Refusing an id there would
    // reject one the owner knows exists, and there is no second provider to send it to anyway.
    const implicit = config({ llm: { baseUrl: "https://one.example/v1", model: "test-model" } });
    expect(resolveRunModel(implicit, { agent: "main", sessionModel: "anything" }, world()).model).toBe("anything");
    // Same once providers exist but no model is declared: the catalog has not spoken yet.
    const empty = config({ llm: { ...config().llm, models: [] } });
    expect(resolveRunModel(empty, { agent: "main", sessionModel: "anything" }, world()).model).toBe("anything");
  });
});

describe("availability", () => {
  test("a provider that answered without listing the model makes it stale", () => {
    const w = world({ answered: (p) => p === "litellm", listedBy: () => new Set(["qwen"]) });
    expect(availabilityOf(config().llm, "mimo-v2.5-pro", w)).toEqual({ state: "stale", provider: "litellm" });
    expect(availabilityOf(config().llm, "qwen", w)).toEqual({ state: "ready" });
  });

  test("a provider that did not answer keeps its models: silence is not absence", () => {
    // The whole reason `answered` exists: a 30-second outage must not empty the picker.
    const w = world({ answered: () => false, listedBy: () => new Set() });
    expect(availabilityOf(config().llm, "mimo-v2.5-pro", w)).toEqual({ state: "ready" });
    expect(runnableModels(config().llm, w)).toHaveLength(5);
  });

  test("a missing env key and an unconnected subscription are told apart", () => {
    const noKey = world({ hasEnv: () => false });
    expect(availabilityOf(config().llm, "qwen", noKey)).toEqual({
      state: "no-key",
      provider: "litellm",
      env: "LITELLM_API_KEY",
    });
    expect(availabilityOf(config().llm, "claude-sonnet-5", world({ claudeAuth: false }))).toEqual({
      state: "no-auth",
      provider: "anthropic",
    });
    expect(availabilityOf(config().llm, "gpt-5.6-sol", world({ codexAuth: false }))).toEqual({
      state: "no-auth",
      provider: "chatgpt",
    });
  });

  test("a picker only offers what can run", () => {
    const w = world({ claudeAuth: false, hasEnv: () => false });
    expect(runnableModels(config().llm, w).map((m) => m.id)).toEqual(["gpt-5.6-sol"]);
  });
});

describe("a dead pin falls back", () => {
  test("an unavailable pin is skipped, recorded, and the global default runs", () => {
    const c = config({ agents: { orchestrator: { llm: { defaultModel: "mimo-v2.5-pro" } } } });
    const w = world({ answered: (p) => p === "litellm", listedBy: () => new Set(["qwen"]) });
    const run = resolveRunModel(c, { agent: "main" }, w);
    expect(run.model).toBe("claude-sonnet-5");
    expect(run.source).toBe("global");
    expect(run.skipped).toHaveLength(1);
    expect(run.skipped[0]).toMatchObject({
      source: "agent",
      model: "mimo-v2.5-pro",
      origin: "config.agents.orchestrator.llm.defaultModel",
      availability: { state: "stale", provider: "litellm" },
    });
  });

  test("the config is never rewritten: the pin survives the fallback", () => {
    const c = config({ agents: { orchestrator: { llm: { defaultModel: "mimo-v2.5-pro" } } } });
    const w = world({ answered: (p) => p === "litellm", listedBy: () => new Set(["qwen"]) });
    resolveRunModel(c, { agent: "main" }, w);
    expect(c.agents?.orchestrator?.llm?.defaultModel).toBe("mimo-v2.5-pro");
  });

  test("an unavailable global default fails loudly: there is nothing below it", () => {
    // Substituting anything here would be inventing a model the owner never named.
    try {
      resolveRunModel(config(), { agent: "main" }, world({ claudeAuth: false }));
      throw new Error("expected a throw");
    } catch (err) {
      expect(err).toBeInstanceOf(NoRunnableModelError);
      expect((err as NoRunnableModelError).availability).toEqual({ state: "no-auth", provider: "anthropic" });
      expect((err as NoRunnableModelError).origin).toBe("config.llm.defaultModel");
    }
  });
});

describe("tags", () => {
  test("a tag is judged by the model it aliases", () => {
    const c = config({ tags: { Fast: { model: "mimo-v2.5-pro" } } });
    const w = world({ answered: (p) => p === "litellm", listedBy: () => new Set(["qwen"]) });
    const run = resolveRunModel(c, { agent: "main", sessionModel: "tag:Fast" }, w);
    // The tag names a stale model, so the pick is skipped like any other dead source.
    expect(run.model).toBe("claude-sonnet-5");
    expect(run.skipped[0]).toMatchObject({ source: "session", model: "tag:Fast" });
  });

  test("tag:Default follows the agent's own default, not the global one", () => {
    const c = config({ agents: { orchestrator: { llm: { defaultModel: "claude-opus-5" } } } });
    const run = resolveRunModel(c, { agent: "main", sessionModel: "tag:Default" }, world());
    expect(run.apiModel).toBe("claude-opus-5");
  });
});

describe("no surface keeps its own chain", () => {
  test("the shortcut that caused the incident exists nowhere in src", async () => {
    // `session.modelOverride ?? config.llm.defaultModel` skips the agent pin. It was written out
    // seven times -- three writes, four reads -- and every one of them lied on a chat that
    // inherited a pin. Criterion 1 of docs/model-resolution.md, as a test rather than a habit.
    const { readdir, readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const offenders: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "__tests__") continue;
          await walk(full);
          continue;
        }
        if (!entry.name.endsWith(".ts")) continue;
        // The one legitimate home of the fallback, where it is the documented last resort.
        if (full.endsWith("llm/chat-model.ts")) continue;
        const text = await readFile(full, "utf-8");
        for (const line of text.split("\n")) {
          if (/modelOverride\s*\?\?\s*(config|p\.config|this\.config|deps\.config)?\.?llm\.defaultModel/.test(line)) {
            offenders.push(`${full}: ${line.trim()}`);
          }
          if (/modelOverride\s*\?\?\s*defaultModel/.test(line)) offenders.push(`${full}: ${line.trim()}`);
        }
      }
    };
    await walk("src");
    expect(offenders).toEqual([]);
  });
});
