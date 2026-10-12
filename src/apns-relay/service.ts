import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { IntegrityVerifier } from "./integrity";
import type { RelayStore } from "./storage";
import type { APNsPublisher, AttestedKey } from "./types";

const keyIdSchema = z.string().length(44).refine(value => Buffer.from(value, "base64").length === 32 &&
  Buffer.from(value, "base64").toString("base64") === value);
const nonceSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const tokenSchema = z.string().regex(/^[a-fA-F0-9]{64,200}$/).transform(value => value.toLowerCase());
const originSchema = z.string().max(2048).transform((value, ctx) => {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error();
    return url.origin;
  } catch { ctx.addIssue({ code: "custom", message: "Invalid HTTPS origin" }); return z.NEVER; }
});
const challengeSchema = z.object({ purpose: z.enum(["attest", "manage"]), keyId: keyIdSchema }).strict();
const attestationSchema = z.object({ nonce: nonceSchema, keyId: keyIdSchema, attestation: z.string().min(1).max(88_000) }).strict();
const registrationSchema = z.object({ nonce: nonceSchema, origin: originSchema, token: tokenSchema }).strict();
const rotationSchema = z.object({ nonce: nonceSchema, token: tokenSchema }).strict();
const revocationSchema = z.object({ nonce: nonceSchema }).strict();
const destination = z.string().regex(/^[A-Za-z0-9._-]{1,64}$/);
const messageSchema = z.object({ title: z.string().min(1).max(256), body: z.string().max(3000), ring: z.boolean(),
  target: z.discriminatedUnion("kind", [z.object({ kind: z.literal("thread"), threadId: destination }).strict(),
    z.object({ kind: z.literal("job"), jobId: destination }).strict()]) }).strict();

class HTTPFailure extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

export function signingPayload(path: string, rawBody: Uint8Array): Buffer {
  return Buffer.concat([Buffer.from(`POST\n${path}\n`), Buffer.from(rawBody)]);
}
export function sendingSecretHash(secret: string): string { return createHash("sha256").update(secret).digest("hex"); }

export class RelayService {
  private readonly limits = new Map<string, { count: number; expires: number }>();
  constructor(private readonly store: RelayStore, private readonly integrity: IntegrityVerifier,
    private readonly publisher: APNsPublisher, private readonly now: () => number = Date.now) {}

  async fetch(request: Request, clientIP: string): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/health" && request.method === "GET") return Response.json({ status: "ok" });
      if (request.method !== "POST") throw new HTTPFailure(405, "method_not_allowed");
      if (url.search) throw new HTTPFailure(400, "invalid_request");
      if (!this.allow(`ip:${clientIP}`, 120)) return this.limited();
      const operation = /^\/v1\/registrations\/([0-9a-f-]{36})\/(publish|token|revoke)$/.exec(url.pathname);
      if (!["/v1/challenges", "/v1/attestations", "/v1/registrations"].includes(url.pathname) && !operation) {
        throw new HTTPFailure(404, "not_found");
      }
      const raw = await readBody(request, operation?.[2] === "publish" ? 4096 : 96 * 1024);
      let body: unknown;
      try { body = JSON.parse(raw.toString("utf8")); } catch { throw new HTTPFailure(400, "invalid_json"); }
      if (url.pathname === "/v1/challenges") {
        const value = challengeSchema.parse(body);
        if (!this.allow(`challenge:${clientIP}`, 30)) return this.limited();
        if (value.purpose === "manage" && !this.store.key(value.keyId)) throw new HTTPFailure(401, "unauthorized");
        this.store.pruneChallenges(this.now());
        const nonce = randomBytes(32).toString("base64url");
        this.store.issueChallenge(nonce, value.purpose, value.keyId, this.now() + 120_000);
        return json({ nonce }, 201);
      }
      if (url.pathname === "/v1/attestations") {
        const value = attestationSchema.parse(body);
        if (!this.store.consumeChallenge(value.nonce, "attest", value.keyId, this.now()) || this.store.key(value.keyId)) {
          throw new HTTPFailure(401, "unauthorized");
        }
        try {
          const verified = this.integrity.attest(value.keyId, value.nonce, base64(value.attestation));
          this.store.addKey({ ...verified, counter: 0 });
        } catch { throw new HTTPFailure(401, "unauthorized"); }
        return new Response(null, { status: 204 });
      }
      if (url.pathname === "/v1/registrations") {
        const value = registrationSchema.parse(body);
        const key = this.authenticate(request, value.nonce, url.pathname, raw);
        const id = randomUUID(); const secret = randomBytes(32).toString("base64url");
        this.store.register({ id, keyId: key.keyId, origin: value.origin, token: value.token,
          secretHash: sendingSecretHash(secret), tokenUpdatedAt: this.now(), active: true });
        return json({ id, secret }, 201);
      }
      const id = operation![1]!;
      if (operation![2] === "publish") {
        const registration = this.store.registrationIncludingRevoked(id);
        const secret = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.get("authorization") ?? "")?.[1];
        const received = Buffer.from(sendingSecretHash(secret ?? ""), "hex");
        const expected = Buffer.from(registration?.secretHash ?? "0".repeat(64), "hex");
        if (!timingSafeEqual(received, expected) || !registration || !secret) throw new HTTPFailure(401, "unauthorized");
        if (!registration.active) throw new HTTPFailure(410, "registration_revoked");
        if (!this.allow(`publish:${id}`, 60)) return this.limited();
        const message = messageSchema.parse(body);
        let outcome;
        try { outcome = await this.publisher.send(registration, message); }
        catch { return json({ error: "apns_unavailable" }, 503, { "Retry-After": "30" }); }
        switch (outcome.kind) {
          case "accepted": return json({ status: "accepted" }, 202);
          case "invalid-token":
            if (outcome.invalidatedAt === undefined || outcome.invalidatedAt >= registration.tokenUpdatedAt) {
              this.store.disableToken(id, registration.token);
            }
            if (this.store.registration(id)) return json({ error: "token_changed" }, 503, { "Retry-After": "1" });
            return json({ error: "token_invalid" }, 410);
          case "temporary": return json({ error: "apns_unavailable" }, 503,
            { "Retry-After": String(Math.min(300, Math.max(1, Math.ceil(outcome.retryAfter)))) });
          case "invalid-payload": throw new HTTPFailure(400, "invalid_payload");
          case "configuration-error": throw new HTTPFailure(503, "provider_unavailable");
        }
      }
      const value = operation![2] === "token" ? rotationSchema.parse(body) : revocationSchema.parse(body);
      const key = this.authenticate(request, value.nonce, url.pathname, raw);
      const registration = this.store.registrationIncludingRevoked(id);
      if (!registration || registration.keyId !== key.keyId) throw new HTTPFailure(401, "unauthorized");
      if ("token" in value) {
        if (!this.store.updateToken(id, key.keyId, tokenSchema.parse(value.token), this.now())) throw new HTTPFailure(410, "registration_revoked");
      } else this.store.revoke(id, key.keyId);
      return new Response(null, { status: 204 });
    } catch (error) {
      if (error instanceof HTTPFailure) return json({ error: error.code }, error.status);
      if (error instanceof z.ZodError) return json({ error: "invalid_request" }, 400);
      return json({ error: "relay_unavailable" }, 503);
    }
  }

  private authenticate(request: Request, nonce: string, path: string, raw: Buffer): AttestedKey {
    try {
      const keyId = keyIdSchema.parse(request.headers.get("x-app-attest-key"));
      const key = this.store.key(keyId);
      if (!key || !this.store.consumeChallenge(nonce, "manage", keyId, this.now())) throw new Error();
      const assertion = base64(request.headers.get("x-app-attest-assertion") ?? "");
      const counter = this.integrity.assertion(key, signingPayload(path, raw), assertion);
      if (!this.store.advanceCounter(keyId, key.counter, counter)) throw new Error();
      return key;
    } catch { throw new HTTPFailure(401, "unauthorized"); }
  }
  private allow(key: string, maximum: number): boolean {
    const now = this.now();
    let bucket = this.limits.get(key);
    if (!bucket || bucket.expires <= now) {
      if (this.limits.size >= 10_000) {
        for (const [id, value] of this.limits) if (value.expires <= now) this.limits.delete(id);
        if (this.limits.size >= 10_000) return false;
      }
      bucket = { count: 0, expires: now + 60_000 }; this.limits.set(key, bucket);
    }
    return ++bucket.count <= maximum;
  }
  private limited(): Response { return json({ error: "rate_limited" }, 429, { "Retry-After": "60" }); }
}

function base64(value: string): Buffer {
  if (!value || value.length > 88_000) throw new Error("Invalid integrity object");
  const bytes = Buffer.from(value, "base64");
  if (bytes.length > 64 * 1024 || bytes.toString("base64") !== value) throw new Error("Invalid integrity object");
  return bytes;
}
function json(value: unknown, status: number, headers: Record<string, string> = {}): Response {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store", ...headers } });
}
async function readBody(request: Request, limit: number): Promise<Buffer> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? "")) throw new HTTPFailure(415, "json_required");
  const reader = request.body?.getReader(); if (!reader) throw new HTTPFailure(400, "body_required");
  let length = 0; const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const result = await reader.read(); if (result.done) break;
      length += result.value.byteLength;
      if (length > limit) { await reader.cancel(); throw new HTTPFailure(413, "payload_too_large"); }
      chunks.push(result.value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}
