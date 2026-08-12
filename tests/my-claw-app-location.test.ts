import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GeoapifyReverseGeocoder, normalizeLocationInput } from "../src/channels/my-claw-app/location.ts";
import type { ChatLocationInput } from "../src/channels/types.ts";
import { mockFetch } from "./helpers/mock-fetch.ts";

const input: ChatLocationInput = {
  latitude: 48.8566,
  longitude: 2.3522,
  accuracyMeters: 24,
  capturedAt: "2026-08-13T12:30:00.000Z",
};

let restore: (() => void) | undefined;

beforeEach(() => {
  delete process.env.GEOAPIFY_API_KEY;
});

afterEach(() => {
  restore?.();
  restore = undefined;
  delete process.env.GEOAPIFY_API_KEY;
});

describe("GeoapifyReverseGeocoder", () => {
  test("is disabled without a non-empty key and makes no request", async () => {
    let calls = 0;
    restore = mockFetch(async () => {
      calls += 1;
      return Response.json({ results: [] });
    }).restore;
    const resolver = new GeoapifyReverseGeocoder(() => process.env.GEOAPIFY_API_KEY);

    expect(resolver.capabilities()).toEqual({ enabled: false, address: false, provider: "geoapify" });
    expect(await resolver.resolve(input)).toEqual(input);
    expect(calls).toBe(0);
  });

  test("maps the nearest result and selects a street-level lookup for a wider fix", async () => {
    process.env.GEOAPIFY_API_KEY = "test-key";
    let requested = "";
    restore = mockFetch(async request => {
      requested = String(request);
      return Response.json({
        results: [{
          formatted: "Rue de Rivoli, 75001 Paris, France",
          result_type: "street",
          street: "Rue de Rivoli",
          city: "Paris",
          postcode: "75001",
          country: "France",
          rank: { confidence: 0.91 },
        }],
      });
    }).restore;
    const resolver = new GeoapifyReverseGeocoder(() => process.env.GEOAPIFY_API_KEY);
    const result = await resolver.resolve({ ...input, accuracyMeters: 42 });

    expect(resolver.capabilities()).toEqual({ enabled: true, address: true, provider: "geoapify" });
    expect(requested).toContain("type=street");
    expect(result.address).toEqual({
      formatted: "Rue de Rivoli, 75001 Paris, France",
      level: "street",
      provider: "geoapify",
      street: "Rue de Rivoli",
      city: "Paris",
      postcode: "75001",
      country: "France",
      confidence: 0.91,
    });
  });

  test("does not trust a client address and uses city level for a poor fix", async () => {
    process.env.GEOAPIFY_API_KEY = "test-key";
    restore = mockFetch(async request => {
      expect(String(request)).toContain("type=city");
      return Response.json({
        results: [{
          formatted: "Paris, France",
          result_type: "city",
          city: "Paris",
          country: "France",
        }],
      });
    }).restore;
    const resolver = new GeoapifyReverseGeocoder(() => process.env.GEOAPIFY_API_KEY);
    const result = await resolver.resolve({
      ...input,
      accuracyMeters: 180,
      address: { formatted: "fake", level: "building", provider: "geoapify" },
    } as ChatLocationInput & { address: unknown });

    expect(result.address).toMatchObject({ formatted: "Paris, France", level: "city" });
    expect(result.address?.houseNumber).toBeUndefined();
  });

  test("falls back to raw coordinates on empty, malformed or failed responses", async () => {
    process.env.GEOAPIFY_API_KEY = "test-key";
    const responses: Array<Response | Promise<Response>> = [
      Response.json({ results: [] }),
      new Response("not json", { status: 200 }),
      new Response("upstream", { status: 503 }),
    ];
    for (const response of responses) {
      restore = mockFetch(async () => response).restore;
      const resolver = new GeoapifyReverseGeocoder(() => process.env.GEOAPIFY_API_KEY);
      expect(await resolver.resolve(input)).toEqual(input);
      restore();
      restore = undefined;
    }
  });

  test("caches the same rounded coordinate lookup", async () => {
    process.env.GEOAPIFY_API_KEY = "test-key";
    let calls = 0;
    restore = mockFetch(async () => {
      calls += 1;
      return Response.json({ results: [{ formatted: "Paris, France", result_type: "city", city: "Paris" }] });
    }).restore;
    const resolver = new GeoapifyReverseGeocoder(() => process.env.GEOAPIFY_API_KEY);

    await resolver.resolve(input);
    await resolver.resolve({ ...input, latitude: input.latitude + 0.00001, longitude: input.longitude + 0.00001 });
    expect(calls).toBe(1);
  });
});

test("normalizeLocationInput validates ranges and strips provider data", () => {
  expect(() => normalizeLocationInput({ ...input, latitude: 91 })).toThrow("latitude");
  expect(normalizeLocationInput({ ...input, address: { formatted: "ignored" } })).toEqual(input);
});
