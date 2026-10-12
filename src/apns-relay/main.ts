import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { AppleIntegrityVerifier } from "./integrity";
import { APNsToken, HTTP2APNsPublisher } from "./provider";
import { RelayService } from "./service";
import { RelayStore } from "./storage";

function required(name: string): string {
  const value = process.env[name]?.trim(); if (!value) throw new Error(`Missing ${name}`); return value;
}
function start(): void {
  const environment = required("APNS_ENVIRONMENT");
  if (environment !== "development" && environment !== "production") throw new Error("Invalid APNS_ENVIRONMENT");
  const teamId = required("APPLE_TEAM_ID"); const bundleId = required("APPLE_BUNDLE_ID");
  if (!/^[A-Z0-9]{10}$/.test(teamId) || !/^[A-Za-z0-9.-]{3,255}$/.test(bundleId)) throw new Error("Invalid Apple identity");
  const versions = required("APP_ATTEST_BUNDLE_VERSIONS").split(",").map(value => value.trim()).filter(Boolean);
  const legacy = process.env.APP_ATTEST_ALLOW_LEGACY;
  if (legacy !== undefined && legacy !== "true" && legacy !== "false") throw new Error("Invalid APP_ATTEST_ALLOW_LEGACY");
  const keyId = required("APNS_KEY_ID");
  if (!/^[A-Z0-9]{10}$/.test(keyId)) throw new Error("Invalid APNS_KEY_ID");
  const token = new APNsToken(teamId, keyId, readFileSync(required("APNS_KEY_FILE"), "utf8"));
  const port = Number(process.env.PORT ?? "8080");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT");
  const proxies = new Set((process.env.RELAY_TRUSTED_PROXIES ?? "").split(",").filter(Boolean));
  if ([...proxies].some(value => !isIP(value))) throw new Error("Invalid RELAY_TRUSTED_PROXIES");
  const store = new RelayStore(process.env.RELAY_DB ?? "/data/relay.sqlite", environment);
  const service = new RelayService(store, new AppleIntegrityVerifier({ teamId, bundleId, environment,
    allowedBundleVersions: versions, allowLegacyClaims: legacy === "true" }), new HTTP2APNsPublisher(environment, bundleId, token));
  const server = Bun.serve({ hostname: process.env.RELAY_HOST ?? "127.0.0.1", port,
    maxRequestBodySize: 96 * 1024, idleTimeout: 15,
    fetch(request, server) {
      let address = server.requestIP(request)?.address ?? "unknown";
      if (proxies.has(address)) {
        const forwarded = request.headers.get("x-real-ip") ?? "";
        if (!isIP(forwarded)) return Response.json({ error: "invalid_proxy_address" }, { status: 400 });
        address = forwarded;
      }
      return service.fetch(request, address);
    },
    error() { return Response.json({ error: "relay_unavailable" }, { status: 503 }); }
  });
  const stop = () => { void server.stop(true).then(() => { store.close(); process.exit(0); }); };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  console.info(`MyClaw APNs relay listening on port ${port} (${environment})`);
}
if (import.meta.main) {
  try { start(); } catch { console.error("APNs relay configuration is invalid; check the required environment and mounted key"); process.exit(1); }
}
