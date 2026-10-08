import { join } from "node:path";
import { Forgejo } from "./forgejo.ts";
import { KeyStore } from "./keys.ts";
import { createRelay } from "./relay.ts";

// The download relay in front of the private Forgejo: docs/release-source.md.

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is not set`);
    process.exit(1);
  }
  return value;
}

const forgejo = new Forgejo(
  (process.env["FORGEJO_URL"] ?? "https://git.kssimi.fr").replace(/\/+$/, ""),
  { repo: required("FORGEJO_TOKEN"), packages: required("FORGEJO_PACKAGE_TOKEN") },
);
try {
  await forgejo.checkAccess();
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
const keys = await KeyStore.open(join(process.env["RELAY_DATA"] ?? "/data", "keys.json"));
const handler = createRelay({
  forgejo,
  keys,
  proxySecret: required("RELAY_PROXY_SECRET"),
  admins: (process.env["RELAY_ADMINS"] ?? "").split(",").map((a) => a.trim()).filter(Boolean),
  publicUrl: required("RELAY_PUBLIC_URL").replace(/\/+$/, ""),
});

const server = Bun.serve({
  port: Number(process.env["PORT"] ?? 8090),
  // A tarball streams for minutes on a slow line: the idle timeout is per silent socket, not per request.
  idleTimeout: 255,
  fetch: handler,
});
console.log(JSON.stringify({ t: new Date().toISOString(), message: "relay listening", port: server.port }));
