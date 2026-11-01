import { describe, expect, test } from "bun:test";
import type { MyClawConfig } from "../src/core/config.ts";
import {
  NoRunnableModelError,
  UnknownModelError,
  availabilityOf,
  overrideForPick,
  resetPinsOnPick,
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
    signedIn: () => true,
    ...over,
  };
}

function config(over: Partial<MyClawConfig> = {}): MyClawConfig {
  return {
    llm: {
      defaultProvider: "anthropic",
      defaultModel: "claude-sonnet-5",
      providers: {
        anthropic: { type: "anthropic", discover: true },
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

describe("what a pick does to the pins set on top of the model", () => {
  test("a tag takes both pins with it, because it carries its own", () => {
    // Precedence: session override > tag candidate cap, and session effort > tag effort. A pin
    // left over from the previous model would silently outrank the tag the owner just picked.
    const pins = { effortOverride: "high" as const, contextOverride: 128_000 as const };
    resetPinsOnPick(pins, "tag:Cheap", "tag:Cheap");
    expect(pins.effortOverride).toBeUndefined();
    expect(pins.contextOverride).toBeUndefined();
  });

  test("a tag drops a 'full' lift too: the tag's ceiling is what applies", () => {
    const pins = { contextOverride: "full" as const };
    resetPinsOnPick(pins, "tag:Cheap", "tag:Cheap");
    expect(pins.contextOverride).toBeUndefined();
  });

  test("picking a plain model keeps the conversation's own pins", () => {
    const pins = { effortOverride: "low" as const, contextOverride: 64_000 as const };
    resetPinsOnPick(pins, "claude-opus-5", "claude-opus-5");
    expect(pins).toEqual({ effortOverride: "low", contextOverride: 64_000 });
  });

  test("a pick that hands the conversation back to its scope drops them as a whole", () => {
    // No override left is the same statement the root "Use default" makes: the whole combo belongs
    // to the config again, not just the model.
    const pins = { effortOverride: "low" as const, contextOverride: 64_000 as const };
    resetPinsOnPick(pins, "claude-sonnet-5", undefined);
    expect(pins.effortOverride).toBeUndefined();
    expect(pins.contextOverride).toBeUndefined();
  });
});

describe("the backend follows the resolved model", () => {
  test("each provider type routes to its own engine, never the default provider's", () => {
    const c = config();
    expect(resolveRunModel(c, { agent: "main", sessionModel: "claude-sonnet-5" }, world()).backend).toBe("anthropic");
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

  test("a model that is not for talking is runnable but never offered", () => {
    const c = config();
    // The catalogue keeps it: availability is about whether its provider can be called, and an
    // embedding endpoint can. Only the menu decides it has nothing to say here.
    c.llm.models = [
      ...(c.llm.models ?? []),
      { id: "gemini/gemini-embedding-001", label: "embedding", provider: "gemini", apiId: "gemini-embedding-001", kind: "embedding" },
      { id: "gemini/gemini-3.8-flash-tts", label: "tts", provider: "gemini", apiId: "gemini-3.8-flash-tts", kind: "speech" },
      { id: "gemini/gemini-3.8-flash", label: "flash", provider: "gemini", apiId: "gemini-3.8-flash" },
    ];
    c.llm.providers = { ...(c.llm.providers ?? {}), gemini: { baseUrl: "https://gemini.test/openai", apiKeyEnv: "GEMINI_API_KEY" } };
    const w = world();
    expect(availabilityOf(c.llm, "gemini/gemini-embedding-001", w)).toEqual({ state: "ready" });
    expect(runnableModels(c.llm, w).map((m) => m.id)).not.toContain("gemini/gemini-embedding-001");
    expect(runnableModels(c.llm, w).map((m) => m.id)).not.toContain("gemini/gemini-3.8-flash-tts");
    // A model with no kind at all is a chat model, which is what almost everything is.
    expect(runnableModels(c.llm, w).map((m) => m.id)).toContain("gemini/gemini-3.8-flash");
  });

  test("a missing env key and an unconnected subscription are told apart", () => {
    const noKey = world({ hasEnv: () => false });
    expect(availabilityOf(config().llm, "qwen", noKey)).toEqual({
      state: "no-key",
      provider: "litellm",
      env: "LITELLM_API_KEY",
    });
    expect(availabilityOf(config().llm, "claude-sonnet-5", world({ signedIn: (p) => p !== "anthropic" }))).toEqual({
      state: "no-auth",
      provider: "anthropic",
    });
    expect(availabilityOf(config().llm, "gpt-5.6-sol", world({ signedIn: (p) => p !== "chatgpt" }))).toEqual({
      state: "no-auth",
      provider: "chatgpt",
    });
  });

  test("an anthropic provider with its own key is judged by that key, not by the subscription", () => {
    // Two providers on the same transport, authenticated differently: judging both by the
    // subscription would hide a keyed backend's models on a box that never logged into Claude.
    const mixed = config({
      llm: {
        defaultProvider: "abo",
        defaultModel: "claude-sonnet-5",
        providers: {
          abo: { type: "anthropic" as const },
          zai: { type: "anthropic" as const, baseUrl: "https://api.z.ai/api/anthropic", apiKeyEnv: "ZAI_API_KEY" },
        },
        models: [
          { id: "claude-sonnet-5", label: "Sonnet 5", provider: "abo" },
          { id: "glm-5", label: "GLM 5", provider: "zai" },
        ],
      },
    });
    const noKey = world({ signedIn: () => true, hasEnv: () => false });
    expect(availabilityOf(mixed.llm, "glm-5", noKey)).toEqual({ state: "no-key", provider: "zai", env: "ZAI_API_KEY" });
    expect(availabilityOf(mixed.llm, "claude-sonnet-5", noKey)).toEqual({ state: "ready" });

    const noSub = world({ signedIn: (p) => p !== "abo", hasEnv: () => true });
    expect(availabilityOf(mixed.llm, "glm-5", noSub)).toEqual({ state: "ready" });
    expect(availabilityOf(mixed.llm, "claude-sonnet-5", noSub)).toEqual({ state: "no-auth", provider: "abo" });
  });

  test("a picker only offers what can run", () => {
    const w = world({ signedIn: (p) => p !== "anthropic", hasEnv: () => false });
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
      resolveRunModel(config(), { agent: "main" }, world({ signedIn: (p) => p !== "anthropic" }));
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

  test("a tag naming a discovered model resolves, whichever way the catalogue spells it", () => {
    // The live incident: discovery qualifies its ids (`anthropic/claude-sonnet-5`) while the tag,
    // the default and every session hold the bare one. Reading availability with `id ===` made
    // the default model of the whole install an unknown id, and every run threw.
    const c = config({
      tags: { Medium: { model: "claude-sonnet-5" } },
      llm: {
        ...config().llm,
        defaultModel: "tag:Medium",
        // Both halves, the way the boot sync leaves them: the availability chain reads the
        // top-level section and the resolver reads the llm view.
        tags: { Medium: { model: "claude-sonnet-5" } },
        models: [
          { id: "anthropic/claude-sonnet-5", apiId: "claude-sonnet-5", label: "Sonnet 5", provider: "anthropic" },
          { id: "litellm/qwen", apiId: "qwen", label: "Qwen", provider: "litellm" },
        ],
      },
    });
    const w = world({ answered: (p) => p === "anthropic", listedBy: () => new Set(["claude-sonnet-5"]) });
    expect(availabilityOf(c.llm, "claude-sonnet-5", w)).toEqual({ state: "ready" });
    // And by its qualified name: the provider is asked about the id it published, not about ours.
    expect(availabilityOf(c.llm, "anthropic/claude-sonnet-5", w)).toEqual({ state: "ready" });
    expect(resolveRunModel(c, { agent: "main" }, w).apiModel).toBe("claude-sonnet-5");
  });

  test("tag:Default follows the agent's own default, not the global one", () => {
    const c = config({ agents: { orchestrator: { llm: { defaultModel: "claude-opus-5" } } } });
    const run = resolveRunModel(c, { agent: "main", sessionModel: "tag:Default" }, world());
    expect(run.apiModel).toBe("claude-opus-5");
  });

  test("a deleted session tag runs the current Default model", () => {
    const c = config();
    const run = resolveRunModel(c, { agent: "main", sessionModel: "tag:gone" }, world());
    expect(run.model).toBe("tag:gone");
    expect(run.apiModel).toBe("claude-sonnet-5");
    expect(run.source).toBe("session");
  });

  test("a deleted agent tag falls back to the global model", () => {
    const c = config({ agents: { orchestrator: { llm: { defaultModel: "tag:gone" } } } });
    const run = resolveRunModel(c, { agent: "main" }, world());
    expect(run.model).toBe("tag:gone");
    expect(run.apiModel).toBe("claude-sonnet-5");
    expect(run.source).toBe("agent");
  });
});

describe("a pin and an image", () => {
  /** A catalogue where only one model reads pictures -- the case that decides the order. */
  const withVision = (): MyClawConfig =>
    config({
      llm: {
        ...config().llm,
        visionFallback: "claude-opus-5",
        models: [
          { id: "claude-sonnet-5", label: "Sonnet 5", provider: "anthropic", vision: false },
          { id: "claude-opus-5", label: "Opus 5", provider: "anthropic", vision: true },
          { id: "qwen", label: "Qwen", provider: "litellm", vision: false },
        ],
      },
    });

  test("the vision reroute beats Siphon's forced model", () => {
    // Siphon says "everything runs on this model", and a model that cannot read the image in the
    // turn cannot do the turn: the reroute wins that once, and the pin is read again next run.
    const run = resolveRunModel(withVision(), { agent: "main", forcedModel: "qwen", hasImages: true }, world());
    expect(run.model).toBe("claude-opus-5");
    expect(run.reroutedFrom).toBe("qwen");
  });

  test("with no image, the pin keeps the run", () => {
    const run = resolveRunModel(withVision(), { agent: "main", forcedModel: "qwen" }, world());
    expect(run.model).toBe("qwen");
    expect(run.reroutedFrom).toBeUndefined();
  });

  test("a pin that reads pictures is never displaced", () => {
    const run = resolveRunModel(withVision(), { agent: "main", forcedModel: "claude-opus-5", hasImages: true }, world());
    expect(run.model).toBe("claude-opus-5");
    expect(run.reroutedFrom).toBeUndefined();
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

describe("availability stays hot", () => {
  // Rewritten 2026-10-04: the env token was read live here. It is adopted into the account's file
  // when .env changes (accounts-store.ts), and the sign-in is judged per provider.
  test("each plan is judged by its own sign-in: a second account signed out hides only its models", () => {
    const two = config({
      llm: {
        defaultProvider: "chatgpt",
        defaultModel: "gpt-5.6-sol",
        providers: {
          chatgpt: { type: "codex" as const },
          "chatgpt-work": { type: "codex" as const },
        },
        models: [
          { id: "gpt-5.6-sol", label: "Sol", provider: "chatgpt" },
          { id: "chatgpt-work/gpt-5.6-sol", label: "Sol (work)", apiId: "gpt-5.6-sol", provider: "chatgpt-work" },
        ],
      },
    });
    const w = world({ signedIn: (p) => p === "chatgpt" });
    expect(availabilityOf(two.llm, "gpt-5.6-sol", w)).toEqual({ state: "ready" });
    expect(availabilityOf(two.llm, "chatgpt-work/gpt-5.6-sol", w)).toEqual({ state: "no-auth", provider: "chatgpt-work" });
  });

  test("a key added to a provider makes its models runnable with no restart", () => {
    // The config object is mutated in place by the watcher, and availability is derived on every
    // read: nothing caches the verdict.
    const c = config();
    const keyless: AvailabilityWorld = { ...world(), hasEnv: (name) => name !== "LITELLM_API_KEY" };
    expect(availabilityOf(c.llm, "qwen", keyless)?.state).toBe("no-key");
    expect(runnableModels(c.llm, keyless).some((m) => m.id === "qwen")).toBe(false);
    expect(runnableModels(c.llm, world()).some((m) => m.id === "qwen")).toBe(true);
  });

  test("a model added to the live config resolves without a restart", () => {
    const c = config();
    // What a hot reload does: replace the section in place.
    c.llm.models = [...(c.llm.models ?? []), { id: "brand-new", label: "Brand new", provider: "litellm" }];
    expect(resolveRunModel(c, { agent: "main", sessionModel: "brand-new" }, world()).model).toBe("brand-new");
  });
});

describe("a provider switched off", () => {
  test("its models read as disabled -- before any key or sign-in question -- and are not offered", () => {
    const base = config();
    const c = config({
      agents: { orchestrator: { llm: { defaultModel: "mimo-v2.5-pro" } } },
      llm: {
        ...base.llm,
        defaultProvider: "litellm",
        defaultModel: "mimo-v2.5-pro",
        providers: { ...base.llm.providers!, anthropic: { type: "anthropic", disabled: true } },
      },
    });
    expect(availabilityOf(c.llm, "claude-opus-5", world())).toEqual({ state: "disabled", provider: "anthropic" });
    // The state outranks the sign-in question: off is off, whatever the token store says.
    expect(availabilityOf(c.llm, "claude-opus-5", world({ signedIn: () => false }))).toEqual({ state: "disabled", provider: "anthropic" });
    expect(runnableModels(c.llm, world()).map((m) => m.id)).toEqual(["gpt-5.6-sol", "mimo-v2.5-pro", "qwen"]);

    // A session pinned on one of its models is skipped like any dead source, and the chain runs.
    const run = resolveRunModel(c, { agent: "main", sessionModel: "claude-opus-5" }, world());
    expect(run.model).toBe("mimo-v2.5-pro");
    expect(run.source).toBe("agent");
    expect(run.skipped[0]).toMatchObject({ source: "session", availability: { state: "disabled" } });
  });

  test("a tag route walks past a disabled candidate to the next one", () => {
    const base = config();
    const tags = { Fast: { route: [{ model: "claude-opus-5" }, { model: "qwen" }] } };
    const c = config({
      tags,
      llm: {
        ...base.llm,
        tags,
        providers: { ...base.llm.providers!, anthropic: { type: "anthropic", disabled: true } },
      },
    });
    const run = resolveRunModel(c, { agent: "main", sessionModel: "tag:Fast" }, world());
    expect(run.model).toBe("qwen");
    expect(run.route?.selectedIndex).toBe(1);
    expect(run.route?.unavailableIndices).toEqual([0]);
  });
});
