import { EMBEDDING_CONSUMERS } from "../core/config.ts";
import type { EmbeddingConfig, EmbeddingConsumer, LlmProviderConfig, MyClawConfig, VoiceConfig } from "../core/config.ts";
import { VoiceManager } from "../voice/manager.ts";

/**
 * What each optional service runs on, derived from the config and the environment, never stored
 * (docs/services.md). The default is always the cloud, or off where there is none.
 */

export type InstallKind = "native" | "compose" | "dev";

type Env = Record<string, string | undefined>;

/** Set by the server's unit (`native`) or the image (`compose`); a server run from a checkout is `dev`. */
export function installKind(env: Env = process.env): InstallKind {
  const kind = env["MY_CLAW_INSTALL"];
  return kind === "native" || kind === "compose" ? kind : "dev";
}

/** Where this install runs its own engines when the config names no URL. */
const SELF_HOSTED: Record<InstallKind, { whisper: string; piper?: string; sidecar: string }> = {
  native: { whisper: "http://127.0.0.1:8000", sidecar: "http://127.0.0.1:9223" },
  dev: { whisper: "http://127.0.0.1:8000", sidecar: "http://127.0.0.1:9223" },
  // Service names of packaging/compose: the containers reach each other by them.
  compose: { whisper: "http://whisper:8000", piper: "http://piper:5000", sidecar: "http://browser:9223" },
};

const trimmed = (value: string | undefined): string | undefined => {
  const v = value?.trim();
  return v ? v.replace(/\/+$/, "") : undefined;
};

/** The URL the owner gave for local speech-to-text, if any. `FASTER_WHISPER_ENDPOINT` predates `voice.stt.url`. */
function ownWhisperUrl(voice: VoiceConfig | undefined, env: Env): string | undefined {
  return trimmed(voice?.stt?.url) ?? trimmed(env["FASTER_WHISPER_ENDPOINT"]);
}

export function whisperEndpoint(voice: VoiceConfig | undefined, env: Env = process.env): string {
  return ownWhisperUrl(voice, env) ?? SELF_HOSTED[installKind(env)].whisper;
}

/** The engine on this machine, the one a bare-metal install starts itself. */
export function usesOwnWhisperUnit(voice: VoiceConfig | undefined, env: Env = process.env): boolean {
  return whisperEndpoint(voice, env) === SELF_HOSTED.native.whisper;
}

/** Undefined on bare metal without a URL: Piper is then the `piper` binary. */
export function piperEndpoint(voice: VoiceConfig | undefined, env: Env = process.env): string | undefined {
  return trimmed(voice?.tts?.url) ?? SELF_HOSTED[installKind(env)].piper;
}

export type ServiceId = "stt" | "tts" | "location" | "embeddings" | "search" | "browser";
export type ServiceSource = "off" | "cloud" | "self-hosted" | "url";

export interface ServiceState {
  id: ServiceId;
  source: ServiceSource;
  /** The URL the server talks to, when it talks to one. */
  endpoint?: string;
  /** What the chosen source still needs before it can work: env names, config keys. */
  missing: string[];
  /**
   * Embeddings only: the model in force, and the provider it comes from when one is named. Read
   * from the config, not from memory, so a page that reopens describes what runs instead of
   * guessing from the endpoint alone (an endpoint is a URL, and two providers can share a host).
   */
  model?: string;
  /** Embeddings only: the `from` provider, when the destination is one of this install's. */
  provider?: string;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/** A URL on one of this install's own engines is self-hosted; anything else is the owner's. */
function selfOrUrl(url: string, kind: InstallKind, composeHost: string): ServiceSource {
  if (kind === "compose") return hostOf(url) === composeHost ? "self-hosted" : "url";
  const host = hostOf(url);
  return host === "127.0.0.1" || host === "localhost" ? "self-hosted" : "url";
}

/**
 * Where an embedding call goes, and what signs it. One rule, read by the state, the probe and the
 * config writer alike: `from` names a provider already configured, and an explicit `baseUrl` is a
 * server that is not one of this install's chat providers (docs/services.md).
 */
export function embeddingEndpoint(
  cfg: EmbeddingConfig | undefined,
  providers: Record<string, LlmProviderConfig> | undefined,
): { baseUrl?: string; apiKeyEnv?: string } {
  if (!cfg) return {};
  if (!cfg.from) return { baseUrl: cfg.baseUrl, apiKeyEnv: cfg.apiKeyEnv };
  const provider = providers?.[cfg.from];
  if (!provider) return {};
  return { baseUrl: provider.baseUrl, apiKeyEnv: provider.apiKeyEnv };
}

const needsEnv = (name: string | undefined, env: Env): string[] => (name && !env[name]?.trim() ? [name] : []);

/** One entry per service, no condition anywhere else. */
const SERVICES: Record<ServiceId, (config: MyClawConfig, env: Env) => Omit<ServiceState, "id">> = {
  stt: (config, env) => {
    if (new VoiceManager(config).resolveMode("stt") === "cloud") return { source: "cloud", missing: needsEnv("GROQ_API_KEY", env) };
    const endpoint = whisperEndpoint(config.voice, env);
    return { source: ownWhisperUrl(config.voice, env) ? selfOrUrl(endpoint, installKind(env), "whisper") : "self-hosted", endpoint, missing: [] };
  },
  // Shared GPS positions are turned into an address by Geoapify: its key is the whole setup.
  location: (_config, env) => ({ source: "cloud", missing: needsEnv("GEOAPIFY_API_KEY", env) }),
  tts: (config, env) => {
    // Edge needs no key (the `edge-tts` binary is what a probe would find missing); Gemini needs its own.
    const voice = new VoiceManager(config);
    if (voice.resolveMode("tts") === "cloud") {
      return { source: "cloud", missing: voice.ttsProvider() === "gemini" ? needsEnv("GEMINI_API_KEY", env) : [] };
    }
    const endpoint = piperEndpoint(config.voice, env);
    if (!endpoint) return { source: "self-hosted", missing: [] };
    return { source: trimmed(config.voice?.tts?.url) ? selfOrUrl(endpoint, installKind(env), "piper") : "self-hosted", endpoint, missing: [] };
  },
  embeddings: (config, env) => {
    const embedding = config.memory?.embedding;
    if (!embedding?.model) return { source: "off", missing: [] };
    if (embedding.backend === "local") return { source: "self-hosted", missing: [], model: embedding.model };
    // A provider the install already speaks to is "cloud" in the same sense OpenAI was: the model
    // runs elsewhere. A bare URL with no key stays "url".
    const { baseUrl, apiKeyEnv } = embeddingEndpoint(embedding, config.llm?.providers);
    const endpoint = trimmed(baseUrl);
    const missing = [...(endpoint ? [] : [embedding.from ? `llm.providers.${embedding.from}` : "memory.embedding.baseUrl"]), ...needsEnv(apiKeyEnv, env)];
    return {
      source: apiKeyEnv ? "cloud" : "url",
      ...(endpoint ? { endpoint } : {}),
      missing,
      model: embedding.model,
      ...(embedding.from ? { provider: embedding.from } : {}),
    };
  },
  search: (config, env) => {
    const endpoint = trimmed(config.webSearch?.baseUrl);
    if (!endpoint) return { source: "off", missing: [] };
    return { source: installKind(env) === "compose" && hostOf(endpoint) === "searxng" ? "self-hosted" : "url", endpoint, missing: [] };
  },
  browser: (config, env) => {
    if (config.browser?.enabled === false) return { source: "off", missing: [] };
    const endpoint = trimmed(config.browser?.sidecarUrl) ?? SELF_HOSTED[installKind(env)].sidecar;
    return { source: selfOrUrl(endpoint, installKind(env), "browser"), endpoint, missing: [] };
  },
};

export const SERVICE_IDS = Object.keys(SERVICES) as ServiceId[];

export function serviceStates(config: MyClawConfig, env: Env = process.env): ServiceState[] {
  return SERVICE_IDS.map((id) => ({ id, ...SERVICES[id](config, env) }));
}

const PROBE_MS = 3000;

/** Up if the endpoint answers at all, whatever the status: a 404 on `/` is still an engine. */
export async function probeService(state: ServiceState): Promise<"up" | "down" | "no-endpoint"> {
  if (!state.endpoint) return "no-endpoint";
  try {
    await fetch(state.endpoint, { signal: AbortSignal.timeout(PROBE_MS) });
    return "up";
  } catch {
    return "down";
  }
}

/** What the owner can pick for a service on this install: self-hosting search needs the compose profile. */
export function choicesOf(id: ServiceId, kind: InstallKind): ServiceSource[] {
  const table: Record<ServiceId, ServiceSource[]> = {
    stt: ["cloud", "self-hosted", "url"],
    tts: ["cloud", "self-hosted", "url"],
    location: ["cloud"],
    embeddings: ["off", "cloud", "self-hosted", "url"],
    search: kind === "compose" ? ["off", "self-hosted", "url"] : ["off", "url"],
    browser: ["off", "self-hosted", "url"],
  };
  return table[id];
}

export interface ServiceChoice {
  id: ServiceId;
  source: ServiceSource;
  /** The engine's address, for `url` (and an embeddings host that is not a configured provider). */
  url?: string;
  /** Embeddings: the model id. */
  model?: string;
  /** Embeddings in the cloud: the .env name holding the key, for a host that is not a provider. */
  keyEnv?: string;
  /**
   * Embeddings in the cloud on a provider this install already has: its key in `llm.providers`.
   * Written as `memory.embedding.from`, so the URL and the key come from there and are never
   * duplicated into memory's own section (docs/memory.md).
   */
  provider?: string;
  /** Embeddings: which consumer this applies to. Absent means the default (`memory.embedding`). */
  consumer?: EmbeddingConsumer;
  /** Embeddings: switches this consumer's semantic half off without losing its model. */
  enabled?: boolean;
  /** Embeddings: drops this consumer's own entry, so it inherits the default again. */
  inherit?: boolean;
}

/** The cloud embeddings default: OpenAI's small model, the cheapest that recall needs. */
export const CLOUD_EMBEDDING = { baseUrl: "https://api.openai.com/v1", model: "text-embedding-3-small", apiKeyEnv: "OPENAI_API_KEY" };
/** In-process, downloaded on first use: the model the recall tests prove (384 dimensions). */
export const LOCAL_EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";

type Raw = Record<string, unknown>;

function child(parent: Raw, key: string): Raw {
  const existing = parent[key];
  if (existing !== null && typeof existing === "object" && !Array.isArray(existing)) return existing as Raw;
  const created: Raw = {};
  parent[key] = created;
  return created;
}

function validUrl(url: string | undefined): string | undefined {
  const value = url?.trim().replace(/\/+$/, "");
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Whether config.json already declares this provider: a name nothing answers for is a typo. */
function isDeclaredProvider(raw: Raw, key: string): boolean {
  const llm = raw["llm"];
  if (llm === null || typeof llm !== "object" || Array.isArray(llm)) return false;
  const providers = (llm as Raw)["providers"];
  if (providers === null || typeof providers !== "object" || Array.isArray(providers)) return false;
  return key in (providers as Raw);
}

/** A voice engine: cloud, the one this install runs, or the owner's at a URL. */
function voicePatch(feature: "stt" | "tts") {
  return (raw: Raw, choice: ServiceChoice, url: string | undefined): void => {
    const section = child(child(raw, "voice"), feature);
    section["mode"] = choice.source === "cloud" ? "cloud" : "local";
    if (choice.source === "url") section["url"] = url;
    else delete section["url"];
  };
}

/**
 * Where one embedding choice is written: `memory.embedding` for the default, or
 * `memory.embeddings.<consumer>` for a consumer that names its own. Returning the target section
 * keeps the three branches below (inherit, on, off) from each having to know about the two shapes.
 */
function embeddingTarget(memory: Raw, consumer: EmbeddingConsumer | undefined): Raw {
  return consumer ? child(child(memory, "embeddings"), consumer) : child(memory, "embedding");
}

/** How each choice is written into config.json. One entry per service, no condition elsewhere. */
const PATCHES: Record<ServiceId, (raw: Raw, choice: ServiceChoice, url: string | undefined) => void> = {
  stt: voicePatch("stt"),
  tts: voicePatch("tts"),
  // Nothing in config.json: the key in .env is the switch.
  location: () => {},
  embeddings: (raw, choice, url) => {
    const memory = child(raw, "memory");
    // One consumer switched on or off, its model kept either way. This comes before `source`
    // because a toggle says nothing about where to go: it only says whether to.
    if (choice.enabled !== undefined) {
      if (!choice.consumer) return;
      const all = child(memory, "embeddings");
      const existing =
        all !== null && typeof all === "object" && !Array.isArray(all)
          ? ((all as Raw)[choice.consumer] as Raw | undefined)
          : undefined;
      if (choice.enabled) {
        if (!existing) return;
        delete existing["enabled"];
        // A consumer that only ever carried the switch follows the default again: an empty entry
        // would say nothing and read as a choice in the config.
        if (Object.keys(existing).length === 0) {
          const rest = (memory["embeddings"] ?? {}) as Raw;
          delete rest[choice.consumer];
          if (Object.keys(rest).length === 0) delete memory["embeddings"];
        }
        return;
      }
      // Off without a model is a state of its own: it pins nothing, so the consumer goes back to
      // following the default the day it is switched on again. `embeddingFor` reads it that way --
      // see docs/memory.md.
      const target = existing ?? (child(child(memory, "embeddings"), choice.consumer) as Raw);
      target["enabled"] = false;
      return;
    }
    // A consumer can drop its own entry at any time and be back on the default; that is the only
    // way to undo a per-consumer choice, so it comes before every other branch.
    if (choice.inherit) {
      if (!choice.consumer) return;
      const all = memory["embeddings"];
      if (all === null || typeof all !== "object" || Array.isArray(all)) return;
      delete (all as Raw)[choice.consumer];
      if (Object.keys(all as Raw).length === 0) delete memory["embeddings"];
      return;
    }
    // "Off" as a source differs by target: the default is removed outright, while a consumer
    // keeps its model and is merely switched off, so switching it back on needs no reconfiguration.
    if (choice.source === "off") {
      if (choice.consumer) {
        const target = embeddingTarget(memory, choice.consumer);
        target["enabled"] = false;
        return;
      }
      delete memory["embedding"];
      return;
    }
    const target = embeddingTarget(memory, choice.consumer);
    // A model set back on clears the off switch that kept it out of the way.
    delete target["enabled"];
    if (choice.source === "self-hosted") {
      target["backend"] = "local";
      target["model"] = choice.model?.trim() || LOCAL_EMBEDDING_MODEL;
      // A local model takes no address and no key, and a leftover from a previous choice would
      // send the call somewhere the config no longer means.
      delete target["from"];
      delete target["baseUrl"];
      delete target["apiKeyEnv"];
      return;
    }
    // A configured provider is named, not copied: one place holds the URL and the key, and moving
    // the account later moves the embedding with it.
    const provider = choice.provider?.trim();
    if (choice.source === "cloud" && provider) {
      target["backend"] = "http";
      target["from"] = provider;
      target["model"] = choice.model?.trim() || CLOUD_EMBEDDING.model;
      return;
    }
    target["backend"] = "http";
    target["baseUrl"] = url ?? CLOUD_EMBEDDING.baseUrl;
    target["model"] = choice.model?.trim() || CLOUD_EMBEDDING.model;
    if (choice.source === "cloud") target["apiKeyEnv"] = choice.keyEnv?.trim() || CLOUD_EMBEDDING.apiKeyEnv;
  },
  search: (raw, choice, url) => {
    child(raw, "webSearch")["baseUrl"] = choice.source === "off" ? "" : choice.source === "self-hosted" ? "http://searxng:8080" : url;
  },
  browser: (raw, choice, url) => {
    const browser = child(raw, "browser");
    browser["enabled"] = choice.source !== "off";
    if (choice.source === "url") browser["sidecarUrl"] = url;
  },
};

/**
 * Writes a choice into a parsed config.json, or says why it cannot. The caller owns the file (read,
 * snapshot, atomic write); this only knows what each choice means.
 */
export function applyServiceChoice(raw: Raw, choice: ServiceChoice, kind: InstallKind): { ok: true } | { ok: false; error: string } {
  if (!(choice.id in PATCHES)) return { ok: false, error: `unknown service: ${String(choice.id)}` };
  if (!choicesOf(choice.id, kind).includes(choice.source)) {
    return { ok: false, error: `${choice.id} cannot be ${choice.source} on this install` };
  }
  const url = validUrl(choice.url);
  if (choice.source === "url" && !url) return { ok: false, error: "an http(s) URL is needed" };
  if (choice.url?.trim() && !url) return { ok: false, error: `not an http(s) URL: ${choice.url}` };
  // The one cross-service rule: a cloud embedding may name a provider, and naming one that does
  // not exist would write a config that only fails at the first recall.
  if (choice.provider?.trim()) {
    if (choice.id !== "embeddings") return { ok: false, error: `only embeddings can come from a provider` };
    if (choice.source !== "cloud") return { ok: false, error: `a provider is only used by the cloud source` };
    if (!isDeclaredProvider(raw, choice.provider.trim())) {
      return { ok: false, error: `unknown provider: ${choice.provider.trim()}` };
    }
  }
  if ((choice.consumer !== undefined || choice.inherit !== undefined) && choice.id !== "embeddings") {
    return { ok: false, error: `only embeddings have consumers` };
  }
  if (choice.consumer !== undefined && !EMBEDDING_CONSUMERS.includes(choice.consumer)) {
    return { ok: false, error: `unknown embedding consumer: ${choice.consumer}` };
  }
  PATCHES[choice.id](raw, choice, url);
  return { ok: true };
}
