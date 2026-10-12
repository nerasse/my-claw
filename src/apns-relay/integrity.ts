import { X509Certificate } from "node:crypto";
import cbor from "cbor";
import { verifyAssertion, verifyAttestation } from "node-app-attest";
import { z } from "zod";
import type { AppleEnvironment, AttestedKey } from "./types";

export interface IntegrityPolicy {
  teamId: string;
  bundleId: string;
  environment: AppleEnvironment;
  allowedBundleVersions: readonly string[];
  allowLegacyClaims: boolean;
}

export interface VerifiedAttestation {
  keyId: string;
  publicKey: string;
  environment: AppleEnvironment;
}

export interface IntegrityVerifier {
  attest(keyId: string, challenge: string, attestation: Buffer): VerifiedAttestation;
  assertion(key: AttestedKey, payload: Buffer, assertion: Buffer): number;
}

export class AppleIntegrityVerifier implements IntegrityVerifier {
  constructor(private readonly policy: IntegrityPolicy, private readonly now: () => number = Date.now) {}
  attest(keyId: string, challenge: string, attestation: Buffer): VerifiedAttestation {
    const object = attestationSchema.parse(decode(attestation));
    const certificates = object.attStmt.x5c.map(value => new X509Certificate(value));
    if (certificates[0]!.ca || !certificates[1]!.ca) throw new Error("Invalid certificate chain order");
    for (const certificate of certificates) {
      const start = Date.parse(certificate.validFrom);
      const end = Date.parse(certificate.validTo);
      const now = this.now();
      if (!Number.isFinite(start) || !Number.isFinite(end) || now < start || now >= end) {
        throw new Error("Invalid certificate validity period");
      }
    }
    const verified: unknown = verifyAttestation({ attestation, challenge, keyId, bundleIdentifier: this.policy.bundleId,
      teamIdentifier: this.policy.teamId, allowDevelopmentEnvironment: this.policy.environment === "development" });
    const result = verifiedSchema.parse(verified);
    if (result.environment !== this.policy.environment || result.keyId !== keyId) throw new Error("Invalid Apple environment");
    validateDistributionClaims(object.authData, true, this.policy);
    return result;
  }
  assertion(key: AttestedKey, payload: Buffer, assertion: Buffer): number {
    if (key.environment !== this.policy.environment) throw new Error("Invalid Apple environment");
    const object = assertionSchema.parse(decode(assertion));
    const verified: unknown = verifyAssertion({ assertion, payload, publicKey: key.publicKey, signCount: key.counter,
      bundleIdentifier: this.policy.bundleId, teamIdentifier: this.policy.teamId });
    const result = z.object({ signCount: z.number().int().positive().max(0xffffffff) }).parse(verified);
    if (result.signCount <= key.counter) throw new Error("Invalid assertion counter");
    validateDistributionClaims(object.authenticatorData, false, this.policy);
    return result.signCount;
  }
}

const bytes = z.instanceof(Buffer);
const attestationSchema = z.object({ fmt: z.literal("apple-appattest"), authData: bytes,
  attStmt: z.object({ x5c: z.tuple([bytes, bytes]), receipt: bytes }) });
const assertionSchema = z.object({ authenticatorData: bytes, signature: bytes });
const verifiedSchema = z.object({ keyId: z.string().min(1), publicKey: z.string().min(64).max(1024),
  environment: z.enum(["development", "production"]) });

function decode(value: Buffer): unknown {
  if (value.length === 0 || value.length > 64 * 1024) throw new Error("Invalid integrity object size");
  const object: unknown = cbor.decodeFirstSync(value, { max_depth: 16, preventDuplicateKeys: true });
  return object;
}

export function validateDistributionClaims(authData: Buffer, attestation: boolean, policy: IntegrityPolicy): void {
  if (authData.length < 37 || authData.length > 16 * 1024) throw new Error("Invalid authenticator data");
  const extended = (authData[32]! & 0x80) !== 0;
  let claims: unknown;
  if (attestation) {
    if (authData.length < 55 || (authData[32]! & 0x40) === 0) throw new Error("Invalid attested credential data");
    const length = authData.readUInt16BE(53);
    if (length !== 32 || 55 + length >= authData.length) throw new Error("Invalid credential identifier");
    const values: unknown[] = cbor.decodeAllSync(authData.subarray(55 + length), { max_depth: 16, preventDuplicateKeys: true });
    if (values.length !== (extended ? 2 : 1)) throw new Error("Invalid attestation extensions");
    claims = extended ? values[1] : undefined;
  } else {
    if (extended) claims = decode(authData.subarray(37));
    else if (authData.length !== 37) throw new Error("Invalid assertion extensions");
  }
  if (!extended) {
    if (!policy.allowLegacyClaims) throw new Error("Distribution claims unavailable");
    return;
  }
  // Apple encodes this UInt32 as a four-byte little-endian CBOR byte string.
  const value = z.object({ apple_validation_category_01: bytes.refine(value => value.length === 4).transform(value => value.readUInt32LE(0)),
    apple_bundle_version_01: z.string().min(1).max(64) }).parse(claims);
  const allowed = policy.environment === "production" ? [2, 4] : [3];
  if (!allowed.includes(value.apple_validation_category_01) || !policy.allowedBundleVersions.includes(value.apple_bundle_version_01)) {
    throw new Error("App distribution is not allowed");
  }
}
