import { appendFileSync } from "node:fs";

const PORT = 8899;
const UPSTREAM = "https://api.anthropic.com";
const LOG = "/tmp/capture/requests.jsonl";
const HOP = new Set(["host", "connection", "content-length", "transfer-encoding"]);

// The token never reaches the log: it is replaced before anything is written.
function redact(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    if (k === "authorization") out[k] = `Bearer <redacted len=${v.length - 7}>`;
    else if (k === "x-api-key") out[k] = "<redacted>";
    else out[k] = v;
  }
  return out;
}

Bun.serve({
  port: PORT,
  idleTimeout: 240,
  async fetch(req) {
    const url = new URL(req.url);
    const raw = Object.fromEntries(req.headers.entries());
    const body = req.method === "POST" ? await req.text() : "";

    appendFileSync(LOG, JSON.stringify({
      at: new Date().toISOString(),
      method: req.method,
      path: url.pathname + url.search,
      headers: redact(raw),
      body: body ? JSON.parse(body) : undefined,
    }) + "\n");

    const fwd = new Headers();
    for (const [k, v] of Object.entries(raw)) if (!HOP.has(k)) fwd.set(k, v);

    const res = await fetch(UPSTREAM + url.pathname + url.search, {
      method: req.method,
      headers: fwd,
      body: body || undefined,
    });
    appendFileSync(LOG, JSON.stringify({
      at: new Date().toISOString(),
      response: { status: res.status, headers: redact(Object.fromEntries(res.headers.entries())) },
    }) + "\n");
    return new Response(res.body, { status: res.status, headers: res.headers });
  },
});
console.log(`proxy up on :${PORT}`);
