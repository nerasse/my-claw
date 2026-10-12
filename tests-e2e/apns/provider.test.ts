import { describe, expect, test } from "bun:test";
import { createServer, connect } from "node:http2";
import { generateKeyPairSync } from "node:crypto";
import { APNsToken, HTTP2APNsPublisher } from "../../src/apns-relay/provider";

describe.skipIf(process.env.APNS_RELAY_E2E !== "1")("APNs provider on a real local HTTP/2 connection", () => {
  test("sends the exact headers and payload, and reads the actual provider response", async () => {
    const server = createServer(); const observed = Promise.withResolvers<{ headers: Record<string, unknown>; payload: string }>();
    server.on("stream", (stream, headers) => {
      let payload = ""; stream.setEncoding("utf8"); stream.on("data", chunk => { payload += chunk; });
      stream.on("end", () => { observed.resolve({ headers, payload }); stream.respond({ ":status": 200 }); stream.end(); });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("No test listener");
    const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const token = new APNsToken("APPLE_TEAM", "APPLE_KEY", keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString());
    const publisher = new HTTP2APNsPublisher("production", "example.app", token, endpoint => {
      expect(endpoint).toBe("https://api.push.apple.com"); return connect(`http://127.0.0.1:${address.port}`);
    });
    try {
      const outcome = await publisher.send({ id: "registration", keyId: "key", origin: "https://instance.example", token: "abcd", tokenUpdatedAt: 0, secretHash: "hash", active: true },
        { title: "Title", body: "Preview", target: { kind: "thread", threadId: "thread" }, ring: false });
      expect(outcome).toEqual({ kind: "accepted" });
      const received = await observed.promise;
      expect(received.headers[":path"]).toBe("/3/device/abcd"); expect(received.headers["apns-topic"]).toBe("example.app");
      expect(received.headers["apns-push-type"]).toBe("alert"); expect(received.headers["authorization"]).toStartWith("bearer ");
      expect(JSON.parse(received.payload).myclaw.registrationId).toBe("registration");
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
