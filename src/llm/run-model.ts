import {
  agentConfigKey,
  agentConfigOf,
  resolveAgentLlm,
  tagNameOf,
  type AgentLlmConfig,
  type AgentToolType,
  type EffortLevel,
  type LlmConfig,
  type LlmModelConfig,
  type MyClawConfig,
  type ResolvedLlmConfig,
} from "../core/config.ts";
import { findModel, resolveLlmConfigForAgentMessage } from "./resolver.ts";

/**
 * Why a model cannot run, computed and never stored. See docs/model-resolution.md.
 *
 * `stale` is the only state that requires evidence: a provider that answered and did not list the
 * model. A provider that did not answer produces no state at all -- reading silence as absence is
 * what would empty the picker on a network hiccup.
 */
export type Availability =
  | { state: "ready" }
  | { state: "stale"; provider: string }
  | { state: "no-key"; provider: string; env: string }
  | { state: "no-auth"; provider: string };

/**
 * What the resolver needs to know about the world outside the config: what each provider last
 * listed, which env keys are set, and whether the two subscription providers are authenticated.
 * Injected rather than read here so the resolution stays a pure function of its inputs.
 */
export interface AvailabilityWorld {
  /** Whether this provider answered its last discovery in full (ModelCatalog.answered). */
  answered: (provider: string) => boolean;
  /** The ids it listed then (ModelCatalog.listedBy). */
  listedBy: (provider: string) => ReadonlySet<string>;
  /** Whether an env variable holds a value. */
  hasEnv: (name: string) => boolean;
  /** The Claude subscription token is present (claudeTokenStatus). */
  claudeAuth: boolean;
  /** The ChatGPT subscription is logged in (codexIsLoggedIn). */
  codexAuth: boolean;
}

/** Which step of the chain a run's model came from. */
export type ModelSource = "session" | "agent" | "agent-file" | "global";

export interface RunModel extends ResolvedLlmConfig {
  /** Which step of the chain won: the only way a screen can explain itself. */
  source: ModelSource;
  /** Set when the vision reroute applied, naming the model it displaced. */
  reroutedFrom?: string;
  /**
   * The sources that were skipped because their model cannot run, nearest first. Empty on the
   * happy path. The run announces the first of these once, then never again -- a run is dozens of
   * requests and a warning on each is a warning that gets ignored.
   */
  skipped: SkippedSource[];
}

export interface SkippedSource {
  source: ModelSource;
  model: string;
  availability: Availability;
  /** Where the owner has to go to fix it, in config terms. */
  origin: string;
}

/** Raised when nothing in the chain can run. There is no step below the global default. */
export class NoRunnableModelError extends Error {
  constructor(
    readonly model: string,
    readonly availability: Availability,
    readonly origin: string,
  ) {
    super(`${model} cannot run (${describe(availability)}), configured in ${origin}`);
    this.name = "NoRunnableModelError";
  }
}

/** Raised when an id belongs to no known model: it must never inherit the default provider. */
export class UnknownModelError extends Error {
  constructor(readonly model: string) {
    super(
      `Unknown model "${model}": no entry in llm.models and no provider discovered it. ` +
        `Declare it with its provider instead of relying on the default one.`,
    );
    this.name = "UnknownModelError";
  }
}

export function describe(availability: Availability): string {
  switch (availability.state) {
    case "ready":
      return "ready";
    case "stale":
      return `${availability.provider} no longer lists it`;
    case "no-key":
      return `${availability.env} is not set`;
    case "no-auth":
      return `the ${availability.provider} subscription is not connected`;
  }
}

/**
 * Availability of one model id. `undefined` for an id no provider owns: that is not an
 * availability question but an unknown id, refused louder and elsewhere.
 */
export function availabilityOf(
  config: LlmConfig,
  modelId: string,
  world: AvailabilityWorld,
): Availability | undefined {
  const model = findModel(config, modelId);
  // Nothing to judge by, and nothing to misroute to: a config with no model list has a single
  // implicit provider (or a catalog that has not spoken yet). Refusing here would reject an id
  // the owner knows exists; the ambiguity this guards against needs a populated list to exist.
  if (!model) {
    if (!config.models?.length) return { state: "ready" };
    return undefined;
  }
  const providerName = model.provider ?? config.defaultProvider ?? "default";
  const provider = config.providers?.[providerName];
  // An id declared without a provider, in a config that names none: same single-provider case.
  if (!provider) return config.providers === undefined ? { state: "ready" } : undefined;

  if (provider.type === "codex") {
    return world.codexAuth ? { state: "ready" } : { state: "no-auth", provider: providerName };
  }
  if (provider.type === "anthropic") {
    return world.claudeAuth ? { state: "ready" } : { state: "no-auth", provider: providerName };
  }
  // An openai-compatible provider needs its key. The resolver's own last-resort env names count:
  // a run would find them, so the picker must not pretend otherwise.
  const env = provider.apiKeyEnv;
  const keyed = env
    ? world.hasEnv(env)
    : world.hasEnv("FIREWORKS_API_KEY") || world.hasEnv("OPENAI_API_KEY");
  if (!keyed && !config.apiKey) {
    return { state: "no-key", provider: providerName, env: env ?? "FIREWORKS_API_KEY" };
  }
  // Only a provider that answered can testify that a model is gone, and it testifies about the id
  // it knows: the catalogue qualifies ids for addressing, the provider never sees that spelling.
  if (world.answered(providerName) && !world.listedBy(providerName).has(model.apiId ?? model.id)) {
    return { state: "stale", provider: providerName };
  }
  return { state: "ready" };
}

/** Every model that can run right now: what a picker is allowed to offer. */
export function runnableModels(config: LlmConfig, world: AvailabilityWorld): LlmModelConfig[] {
  return (config.models ?? []).filter((m) => availabilityOf(config, m.id, world)?.state === "ready");
}

/**
 * A tag is runnable when the model it aliases is. An unknown tag is left to the resolver.
 *
 * The aliases are read from both the top-level section and the llm view: the boot sync copies one
 * into the other, and a caller holding a config that predates the sync would otherwise see every
 * tag as an unknown id.
 */
function tagTargetOf(config: MyClawConfig, modelId: string): string | undefined {
  const name = tagNameOf(modelId);
  if (name === undefined) return undefined;
  if (name === "Default") return config.llm.defaultModel ?? config.llm.model;
  return (config.tags ?? config.llm.tags)?.[name]?.model;
}

/**
 * Availability of what a chain step names, tag references followed. `undefined` when the id is
 * unknown, which the caller turns into UnknownModelError rather than a silent reroute.
 */
function stepAvailability(
  config: MyClawConfig,
  modelId: string,
  world: AvailabilityWorld,
): Availability | undefined {
  const target = tagTargetOf(config, modelId);
  if (target === undefined) return availabilityOf(config.llm, modelId, world);
  // A tag chain ends on a real model; a broken chain is the resolver's business (it throws on a
  // cycle and passes an unknown name through).
  return stepAvailability(config, target, world);
}

export interface RunModelRequest {
  /** "main" for the orchestrator, "cron" for a scheduled run, else the sub-agent's kind. */
  agent: AgentToolType;
  /** The chat's own pick. */
  sessionModel?: string;
  sessionEffort?: EffortLevel;
  sessionScopeEffort?: EffortLevel;
  /** The agent file's `model:`, which sits under the config entry. */
  fileModel?: string;
  /** Forces the model, skipping the chain: a reroute the resolver itself decided. */
  forcedModel?: string;
  hasImages?: boolean;
}

interface Step {
  source: ModelSource;
  model: string;
  origin: string;
}

/**
 * The model a run uses, with the chain that produced it. One implementation, called by the
 * dispatcher, both backends, both compaction paths and every display: two implementations is how
 * a chat pinned to one model came to run another with no screen saying so.
 *
 * Precedence: the chat's pick, the agent's config pin, the agent file's `model:`, the global
 * default. A step naming a model that cannot run is skipped and recorded in `skipped`; the global
 * default has nothing below it, so it throws instead.
 */
export function resolveRunModel(
  config: MyClawConfig,
  request: RunModelRequest,
  world: AvailabilityWorld,
): RunModel {
  const agentLlm: AgentLlmConfig | undefined = resolveAgentLlm(config, request.agent, request.fileModel);
  const globalDefault = config.llm.defaultModel ?? config.llm.model ?? "";

  const steps: Step[] = [];
  if (request.forcedModel) {
    steps.push({ source: "session", model: request.forcedModel, origin: "the run's own reroute" });
  } else {
    if (request.sessionModel) {
      steps.push({ source: "session", model: request.sessionModel, origin: "this conversation's model" });
    }
    // resolveAgentLlm already collapsed the config entry and the file into one answer; the source
    // is told apart by which of the two carried the id.
    const pin = agentLlm?.defaultModel;
    if (pin) {
      steps.push({ source: pinSource(config, request, pin), model: pin, origin: pinOrigin(config, request, pin) });
    }
    if (globalDefault) {
      steps.push({ source: "global", model: globalDefault, origin: "config.llm.defaultModel" });
    }
  }

  const skipped: SkippedSource[] = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const availability = stepAvailability(config, step.model, world);
    if (availability === undefined) throw new UnknownModelError(step.model);
    if (availability.state !== "ready") {
      const last = i === steps.length - 1;
      // Nothing below the global default: substituting anything here would be inventing a model.
      if (last) throw new NoRunnableModelError(step.model, availability, step.origin);
      skipped.push({ source: step.source, model: step.model, availability, origin: step.origin });
      continue;
    }
    return build(config, request, step, agentLlm, skipped);
  }
  // No step at all: no session pick, no pin, no global default.
  throw new UnknownModelError("");
}

/**
 * What to store in `session.modelOverride` for a pick. The override is cleared only when the pick
 * is *what would run without it* -- which is the agent's pin when there is one, not the global
 * default.
 *
 * Comparing against the global default is the bug this replaces: on a chat whose agent pinned B,
 * picking the global default A cleared the override and handed the run straight back to B. The app
 * then displayed A, because it computed the current model the same wrong way.
 *
 * The comparison is on raw ids, so picking a tag that happens to alias the inherited model still
 * pins the tag: a tag carries its own effort, and dropping it would drop that too.
 */
export function overrideForPick(
  config: MyClawConfig,
  request: Omit<RunModelRequest, "sessionModel">,
  pick: string,
  world: AvailabilityWorld,
): string | undefined {
  const inherited = tryResolveRunModel(config, request, world);
  return inherited?.model === pick ? undefined : pick;
}

/**
 * The same answer, for callers that must not fail on it: a compaction summarizer or a status line
 * has no business throwing because a pin went stale. `undefined` means "no answer", and the caller
 * keeps whatever behaviour it had before asking.
 */
export function tryResolveRunModel(
  config: MyClawConfig,
  request: RunModelRequest,
  world: AvailabilityWorld,
): RunModel | undefined {
  try {
    return resolveRunModel(config, request, world);
  } catch {
    return undefined;
  }
}

function build(
  config: MyClawConfig,
  request: RunModelRequest,
  step: Step,
  agentLlm: AgentLlmConfig | undefined,
  skipped: SkippedSource[],
): RunModel {
  const resolved = resolveLlmConfigForAgentMessage(
    config.llm,
    agentLlm,
    step.model,
    request.hasImages === true,
    request.sessionEffort,
    request.sessionScopeEffort,
  );
  // The vision reroute happens inside the resolver, so the displaced model is whatever the step
  // named: comparing the two is the only way to know it fired.
  const rerouted = resolved.model !== step.model ? step.model : undefined;
  return {
    ...resolved,
    source: step.source,
    ...(rerouted ? { reroutedFrom: rerouted } : {}),
    skipped,
  };
}

/**
 * Which of the two collapsed sources carried the pin. The config entry wins over the file in
 * `resolveAgentLlm`, so the file only spoke when the entry says nothing -- and `cron` is the one
 * agent that inherits, which the origin string has to name or it points at an empty entry.
 */
function pinSource(config: MyClawConfig, request: RunModelRequest, pin: string): ModelSource {
  if (agentConfigOf(config, request.agent)?.llm?.defaultModel === pin) return "agent";
  if (request.fileModel === pin) return "agent-file";
  return "agent";
}

function pinOrigin(config: MyClawConfig, request: RunModelRequest, pin: string): string {
  const own = agentConfigOf(config, request.agent)?.llm?.defaultModel;
  if (own === pin) return `config.agents.${agentConfigKey(request.agent)}.llm.defaultModel`;
  if (request.fileModel === pin) return `the \`model:\` of the ${request.agent} agent file`;
  // Only cron reaches this: an absent entry inherits the orchestrator's, so that is where it lives.
  return "config.agents.orchestrator.llm.defaultModel";
}
