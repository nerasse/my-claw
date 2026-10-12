import { expect, test } from "bun:test";
import production from "./fixtures/app-attest/attestation-production.json";
import development from "./fixtures/app-attest/attestation-development.json";
import assertion from "./fixtures/app-attest/assertion.json";
import cbor from "cbor";
import { AppleIntegrityVerifier, validateDistributionClaims, type IntegrityPolicy } from "../../src/apns-relay/integrity";

const policy: IntegrityPolicy = { teamId: "V8H6LQ9448", bundleId: "io.uebelacker.AppAttestExample", environment: "production",
  allowedBundleVersions: ["fixture"], allowLegacyClaims: true };
const fixtureClock = () => Date.parse("2024-02-07T22:00:00Z");
function attest(config = policy, now = fixtureClock) {
  return new AppleIntegrityVerifier(config, now).attest(production.keyId,
    Buffer.from(production.challenge, "base64").toString("utf8"), Buffer.from(production.attestation, "base64"));
}

test("a real Apple chain and signed nonce validate with the public fixture's clock", () => {
  const result = attest();
  expect(result.keyId).toBe(production.keyId);
  expect(result.environment).toBe("production");
  expect(result.publicKey).toContain("BEGIN PUBLIC KEY");
});
test("expired credential certificates are refused", () => {
  expect(() => attest(policy, () => Date.parse("2026-10-09T00:00:00Z"))).toThrow();
});
test("neither another app identity nor a changed challenge verifies", () => {
  expect(() => attest({ ...policy, bundleId: "other.app" })).toThrow();
  expect(() => new AppleIntegrityVerifier(policy, fixtureClock).attest(production.keyId,
    "another-challenge", Buffer.from(production.attestation, "base64"))).toThrow();
});
test("development and production attestations cannot cross relay environments", () => {
  expect(() => new AppleIntegrityVerifier(policy, fixtureClock).attest(development.keyId,
    Buffer.from(development.challenge, "base64").toString("utf8"), Buffer.from(development.attestation, "base64"))).toThrow();
  expect(() => attest({ ...policy, environment: "development" })).toThrow();
});
test("legacy distribution claims require explicit relay configuration", () => {
  expect(() => attest({ ...policy, allowLegacyClaims: false })).toThrow();
});

test("a real signed assertion authenticates the exact bytes and advances its counter", () => {
  const verifier = new AppleIntegrityVerifier(policy, fixtureClock);
  const key = { keyId: "public-fixture-key", publicKey: assertion.publicKey, environment: "production" as const, counter: 0 };
  const signed = Buffer.from(assertion.assertion, "base64");
  const payload = Buffer.from(assertion.payload);
  expect(verifier.assertion(key, payload, signed)).toBe(1);
  expect(() => verifier.assertion({ ...key, counter: 1 }, payload, signed)).toThrow();
  expect(() => verifier.assertion(key, Buffer.from("different bytes"), signed)).toThrow();
});

function authenticator(category: number, version: string): Buffer {
  const header = Buffer.alloc(37); header[32] = 0x80;
  const value = Buffer.alloc(4); value.writeUInt32LE(category);
  return Buffer.concat([header, cbor.encode({ apple_validation_category_01: value, apple_bundle_version_01: version })]);
}
test("distribution claims allow TestFlight/App Store and only configured versions", () => {
  const strict = { ...policy, allowLegacyClaims: false, allowedBundleVersions: ["143"] };
  expect(() => validateDistributionClaims(authenticator(2, "143"), false, strict)).not.toThrow();
  expect(() => validateDistributionClaims(authenticator(4, "143"), false, strict)).not.toThrow();
  expect(() => validateDistributionClaims(authenticator(3, "143"), false, strict)).toThrow();
  expect(() => validateDistributionClaims(authenticator(5, "143"), false, strict)).toThrow();
  expect(() => validateDistributionClaims(authenticator(2, "old"), false, strict)).toThrow();
  expect(() => validateDistributionClaims(authenticator(2, "143"), false, { ...strict, environment: "development" })).toThrow();
});

test("Apple distribution categories require exactly four little-endian bytes", () => {
  const strict = { ...policy, environment: "development" as const, allowLegacyClaims: false, allowedBundleVersions: ["1"] };
  expect(() => validateDistributionClaims(authenticator(3, "1"), false, strict)).not.toThrow();
  const header = Buffer.alloc(37); header[32] = 0x80;
  for (const category of [3, Buffer.from([3]), Buffer.alloc(5), Buffer.from([0, 0, 0, 3])]) {
    const data = Buffer.concat([header, cbor.encode({ apple_validation_category_01: category, apple_bundle_version_01: "1" })]);
    expect(() => validateDistributionClaims(data, false, strict)).toThrow();
  }
});
