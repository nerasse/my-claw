import { createHash, createPrivateKey, sign, type KeyObject } from "node:crypto";
import { connect, type ClientHttp2Session } from "node:http2";
import type { APNsPublisher, AppleEnvironment, PublishOutcome, RelayMessage, RelayRegistration } from "./types";

export class APNsToken {
  private readonly key: KeyObject;
  private cached?: { value: string; issuedAt: number };
  constructor(private readonly teamId: string, private readonly keyId: string, pem: string,
    private readonly now: () => number = Date.now) {
    this.key = createPrivateKey(pem);
    if (this.key.asymmetricKeyType !== "ec" || this.key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
      throw new Error("APNs requires a P-256 signing key");
    }
  }
  value(): string {
    const now = this.now();
    if (this.cached && now >= this.cached.issuedAt && now - this.cached.issuedAt < 50 * 60_000) return this.cached.value;
    const header = Buffer.from(JSON.stringify({ alg: "ES256", kid: this.keyId })).toString("base64url");
    const claims = Buffer.from(JSON.stringify({ iss: this.teamId, iat: Math.floor(now / 1000) })).toString("base64url");
    const payload = `${header}.${claims}`;
    const signature = sign("sha256", Buffer.from(payload), { key: this.key, dsaEncoding: "ieee-p1363" }).toString("base64url");
    const value = `${payload}.${signature}`; this.cached = { value, issuedAt: now }; return value;
  }
}
export function apnsEnvelope(registration: RelayRegistration, message: RelayMessage) {
  const destination = message.target.kind === "thread" ? message.target.threadId : message.target.jobId;
  return { aps: { alert: { title: message.title, body: message.body }, sound: "default",
    "thread-id": `${message.target.kind}:${destination}` }, myclaw: { origin: registration.origin,
    registrationId: registration.id, target: message.target } };
}
export function classifyAPNsResponse(status: number, body: string): PublishOutcome {
  if (status === 200) return { kind: "accepted" };
  let reason = ""; let timestamp: number | undefined;
  try {
    const value: unknown = JSON.parse(body);
    if (value && typeof value === "object" && "reason" in value && typeof value.reason === "string") reason = value.reason;
    if (value && typeof value === "object" && "timestamp" in value && typeof value.timestamp === "number" && Number.isFinite(value.timestamp)) timestamp = value.timestamp;
  } catch {}
  if (["BadDeviceToken", "DeviceTokenNotForTopic", "Unregistered"].includes(reason)) {
    return { kind: "invalid-token", ...(timestamp === undefined ? {} : { invalidatedAt: timestamp }) };
  }
  if (status === 429 || status >= 500) return { kind: "temporary", retryAfter: 30 };
  if (status === 403 || ["BadTopic", "MissingTopic", "TopicDisallowed", "InvalidProviderToken"].includes(reason)) return { kind: "configuration-error" };
  return { kind: "invalid-payload" };
}

export class HTTP2APNsPublisher implements APNsPublisher {
  private readonly endpoint: string;
  constructor(environment: AppleEnvironment, private readonly bundleId: string, private readonly token: APNsToken,
    private readonly open: (url: string) => ClientHttp2Session = connect) {
    this.endpoint = environment === "production" ? "https://api.push.apple.com" : "https://api.sandbox.push.apple.com";
  }
  async send(registration: RelayRegistration, message: RelayMessage): Promise<PublishOutcome> {
    const payload = JSON.stringify(apnsEnvelope(registration, message));
    if (Buffer.byteLength(payload) > 4096) return { kind: "invalid-payload" };
    return new Promise(resolve => {
      const session = this.open(this.endpoint);
      let settled = false;
      const finish = (outcome: PublishOutcome) => {
        if (settled) return; settled = true; clearTimeout(timeout); session.destroy(); resolve(outcome);
      };
      const timeout = setTimeout(() => finish({ kind: "temporary", retryAfter: 30 }), 10_000);
      session.on("error", () => finish({ kind: "temporary", retryAfter: 30 }));
      session.on("close", () => finish({ kind: "temporary", retryAfter: 30 }));
      try {
        const stream = session.request({ ":method": "POST", ":path": `/3/device/${registration.token}`,
          authorization: `bearer ${this.token.value()}`, "apns-topic": this.bundleId, "apns-push-type": "alert",
          "apns-priority": "10", "apns-expiration": String(Math.floor(Date.now() / 1000) + 3600),
          "apns-collapse-id": createHash("sha256").update(JSON.stringify(message.target)).digest("hex"),
          "content-type": "application/json" });
        let status = 0; let length = 0; const chunks: Buffer[] = [];
        stream.on("response", headers => { status = Number(headers[":status"] ?? 0); });
        stream.on("data", (chunk: Buffer) => {
          length += chunk.length;
          if (length > 8192) finish({ kind: "temporary", retryAfter: 30 }); else chunks.push(chunk);
        });
        stream.on("error", () => finish({ kind: "temporary", retryAfter: 30 }));
        stream.on("end", () => finish(status ? classifyAPNsResponse(status, Buffer.concat(chunks).toString("utf8")) : { kind: "temporary", retryAfter: 30 }));
        stream.end(payload);
      } catch { finish({ kind: "temporary", retryAfter: 30 }); }
    });
  }
}
