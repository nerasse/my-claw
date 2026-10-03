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

export type ServiceId = "stt" | "tts" | "embeddings" | "search" | "browser";
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
  tts: (config, env) => {
    // Edge needs no key; the `edge-tts` binary is what a probe would find missing.
    if (new VoiceManager(config).resolveMode("tts") === "cloud") return { source: "cloud", missing: [] };
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
