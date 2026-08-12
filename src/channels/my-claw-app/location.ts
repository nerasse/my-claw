import type {
  ChatLocation,
  ChatLocationAddress,
  ChatLocationInput,
  LocationAddressLevel,
} from "../types.ts";

export interface MyClawAppLocationCapabilities {
  enabled: boolean;
  address: boolean;
  provider: "geoapify";
}

export interface MyClawAppLocationResolver {
  capabilities(): MyClawAppLocationCapabilities;
  resolve(input: ChatLocationInput): Promise<ChatLocation>;
}

const REVERSE_URL = "https://api.geoapify.com/v1/geocode/reverse";
const LOOKUP_TIMEOUT_MS = 5_000;
const CACHE_PRECISION = 4;

function numberOf(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${name} must be a finite number`);
  return value;
}

function optionalNumber(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  return numberOf(value, name);
}

function cleanText(value: unknown, max = 240): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : undefined;
}

function dateOf(value: unknown): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error("capturedAt must be an ISO date");
  }
  return new Date(value).toISOString();
}

export function normalizeLocationInput(raw: unknown): ChatLocationInput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("location must be an object");
  const value = raw as Record<string, unknown>;
  const latitude = numberOf(value.latitude, "latitude");
  const longitude = numberOf(value.longitude, "longitude");
  const accuracyMeters = numberOf(value.accuracyMeters, "accuracyMeters");
  if (latitude < -90 || latitude > 90) throw new Error("latitude is outside [-90, 90]");
  if (longitude < -180 || longitude > 180) throw new Error("longitude is outside [-180, 180]");
  if (accuracyMeters < 0 || accuracyMeters > 100_000) throw new Error("accuracyMeters is outside [0, 100000]");

  const altitudeMeters = optionalNumber(value.altitudeMeters, "altitudeMeters");
  const headingDegrees = optionalNumber(value.headingDegrees, "headingDegrees");
  const speedMetersPerSecond = optionalNumber(value.speedMetersPerSecond, "speedMetersPerSecond");
  if (headingDegrees !== undefined && (headingDegrees < 0 || headingDegrees >= 360)) {
    throw new Error("headingDegrees is outside [0, 360)");
  }
  if (speedMetersPerSecond !== undefined && speedMetersPerSecond < 0) {
    throw new Error("speedMetersPerSecond must be positive");
  }

  return {
    latitude,
    longitude,
    accuracyMeters,
    capturedAt: dateOf(value.capturedAt),
    ...(altitudeMeters === undefined ? {} : { altitudeMeters }),
    ...(headingDegrees === undefined ? {} : { headingDegrees }),
    ...(speedMetersPerSecond === undefined ? {} : { speedMetersPerSecond }),
  };
}

function levelFor(resultType: string | undefined, accuracyMeters: number): LocationAddressLevel {
  if (accuracyMeters > 100) return "city";
  if (resultType === "country") return "country";
  if (resultType === "city" || resultType === "county" || resultType === "state") return "city";
  if (resultType === "suburb" || resultType === "district" || resultType === "postcode") return "locality";
  if (resultType === "street" || accuracyMeters > 25) return "street";
  return "building";
}

function lookupType(accuracyMeters: number): "street" | "city" | undefined {
  if (accuracyMeters > 100) return "city";
  if (accuracyMeters > 25) return "street";
  return undefined;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function confidenceOf(value: unknown): number | undefined {
  const rank = recordOf(value);
  const confidence = rank?.confidence;
  if (typeof confidence !== "number" || !Number.isFinite(confidence)) return undefined;
  return Math.max(0, Math.min(1, confidence));
}

function addressFromResult(value: unknown, accuracyMeters: number): ChatLocationAddress | undefined {
  const result = recordOf(value);
  if (!result) return undefined;
  const formatted = cleanText(result.formatted, 320);
  if (!formatted) return undefined;
  const resultType = cleanText(result.result_type, 40);
  return {
    formatted,
    level: levelFor(resultType, accuracyMeters),
    provider: "geoapify",
    ...(cleanText(result.street, 160) ? { street: cleanText(result.street, 160) } : {}),
    ...(cleanText(result.housenumber, 40) && accuracyMeters <= 25 ? { houseNumber: cleanText(result.housenumber, 40) } : {}),
    ...(cleanText(result.city, 120) ? { city: cleanText(result.city, 120) } : {}),
    ...(cleanText(result.postcode, 30) ? { postcode: cleanText(result.postcode, 30) } : {}),
    ...(cleanText(result.country, 120) ? { country: cleanText(result.country, 120) } : {}),
    ...(confidenceOf(result.rank) === undefined ? {} : { confidence: confidenceOf(result.rank) }),
  };
}

export class GeoapifyReverseGeocoder implements MyClawAppLocationResolver {
  private cache = new Map<string, ChatLocationAddress | null>();

  constructor(private readonly key: () => string | undefined) {}

  capabilities(): MyClawAppLocationCapabilities {
    const enabled = Boolean(this.key()?.trim());
    return { enabled, address: enabled, provider: "geoapify" };
  }

  async resolve(input: ChatLocationInput): Promise<ChatLocation> {
    const normalized = normalizeLocationInput(input);
    const apiKey = this.key()?.trim();
    if (!apiKey) return normalized;

    const type = lookupType(normalized.accuracyMeters);
    const cacheKey = [
      normalized.latitude.toFixed(CACHE_PRECISION),
      normalized.longitude.toFixed(CACHE_PRECISION),
      type ?? "default",
    ].join(":");
    if (!this.cache.has(cacheKey)) {
      this.cache.set(cacheKey, await this.lookup(apiKey, normalized, type));
    }
    const address = this.cache.get(cacheKey) ?? null;
    return address ? { ...normalized, address } : normalized;
  }

  private async lookup(
    apiKey: string,
    location: ChatLocationInput,
    type: "street" | "city" | undefined,
  ): Promise<ChatLocationAddress | null> {
    const params = new URLSearchParams({
      lat: String(location.latitude),
      lon: String(location.longitude),
      lang: "fr",
      format: "json",
      apiKey,
    });
    if (type) params.set("type", type);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);
    try {
      const response = await fetch(`${REVERSE_URL}?${params.toString()}`, { signal: controller.signal });
      if (!response.ok) return null;
      const body = await response.json() as unknown;
      const results = recordOf(body)?.results;
      if (!Array.isArray(results)) return null;
      return addressFromResult(results[0], location.accuracyMeters) ?? null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
