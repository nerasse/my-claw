import type { MyClawConfig, VoiceConfig } from "../core/config.ts";
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
    if (embedding.backend === "local") return { source: "self-hosted", missing: [] };
    const endpoint = trimmed(embedding.baseUrl);
    const missing = [...(endpoint ? [] : ["memory.embedding.baseUrl"]), ...needsEnv(embedding.apiKeyEnv, env)];
    return { source: embedding.apiKeyEnv ? "cloud" : "url", ...(endpoint ? { endpoint } : {}), missing };
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
  /** The engine's address, for `url` (and a cloud embeddings provider other than OpenAI). */
  url?: string;
  /** Embeddings: the model id. */
  model?: string;
  /** Embeddings in the cloud: the .env name holding the key. */
  keyEnv?: string;
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

/** A voice engine: cloud, the one this install runs, or the owner's at a URL. */
function voicePatch(feature: "stt" | "tts") {
  return (raw: Raw, choice: ServiceChoice, url: string | undefined): void => {
    const section = child(child(raw, "voice"), feature);
    section["mode"] = choice.source === "cloud" ? "cloud" : "local";
    if (choice.source === "url") section["url"] = url;
    else delete section["url"];
  };
}

/** How each choice is written into config.json. One entry per service, no condition elsewhere. */
const PATCHES: Record<ServiceId, (raw: Raw, choice: ServiceChoice, url: string | undefined) => void> = {
  stt: voicePatch("stt"),
  tts: voicePatch("tts"),
  // Nothing in config.json: the key in .env is the switch.
  location: () => {},
  embeddings: (raw, choice, url) => {
    const memory = child(raw, "memory");
    if (choice.source === "off") {
      delete memory["embedding"];
      return;
    }
    if (choice.source === "self-hosted") {
      memory["embedding"] = { backend: "local", model: choice.model?.trim() || LOCAL_EMBEDDING_MODEL };
      return;
    }
    memory["embedding"] = {
      backend: "http",
      baseUrl: url ?? CLOUD_EMBEDDING.baseUrl,
      model: choice.model?.trim() || CLOUD_EMBEDDING.model,
      ...(choice.source === "cloud" ? { apiKeyEnv: choice.keyEnv?.trim() || CLOUD_EMBEDDING.apiKeyEnv } : {}),
    };
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
  PATCHES[choice.id](raw, choice, url);
  return { ok: true };
}
