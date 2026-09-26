// my-claw browser sidecar.
//
// WHY this exists: Playwright's chromium.connectOverCDP hangs forever under Bun
// (the app runtime), while it works under Node. This process owns ALL Playwright
// usage and runs under Node; the Bun app drives it over loopback HTTP. Playwright
// objects (Page/Context) never cross the process boundary — they are referenced by
// opaque string ids. Screenshots are written to /tmp (shared FS) and only the path
// is returned.
//
// Layout: browser.mjs owns the CDP connection and registries, snapshot.mjs turns a page
// into refs, handlers.mjs implements the operations, and this file only routes.
import http from "node:http";
import { CDP_URL } from "./browser.mjs";
import { handlers } from "./handlers.mjs";

const PORT = Number(process.env.PORT || 9223);
const HOST = process.env.HOST || "127.0.0.1";

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(new Error(`Invalid JSON body: ${String(e)}`));
      }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const path = (req.url || "").replace(/^\//, "").split("?")[0];
  const handler = handlers[path];
  if (!handler) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: `Unknown endpoint: ${path}` }));
    return;
  }
  try {
    const body = req.method === "GET" ? {} : await readBody(req);
    const result = await handler(body);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(result ?? {}));
  } catch (e) {
    res.writeHead(500, { "content-type": "application/json" });
    // `frozen` travels with the error: whether those tabs may be closed is the server's call, which
    // alone knows the ones a human is working in.
    const frozen = e && typeof e === "object" && Array.isArray(e.frozen) ? { frozen: e.frozen } : {};
    res.end(JSON.stringify({ error: String(e instanceof Error ? e.message : e), ...frozen }));
  }
});

// A stray rejection from playwright-core internals must not kill the sidecar (Restart=always
// would then flap it); log and keep serving.
process.on("unhandledRejection", (reason) => {
  console.error("[sidecar] unhandled rejection:", reason);
});

server.on("error", (err) => {
  console.error("[sidecar] server error:", err);
  if (err && err.code === "EADDRINUSE") {
    console.error(`[sidecar] ${HOST}:${PORT} already in use (stale sidecar?) — exiting.`);
    process.exit(1);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`my-claw browser sidecar listening on http://${HOST}:${PORT} (CDP ${CDP_URL})`);
});
