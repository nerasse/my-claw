import { appendFileSync } from "node:fs";

const PORT = 8899;
const UPSTREAM = "https://api.anthropic.com";
const LOG = "/tmp/capture/requests.jsonl";
const HOP = new Set(["host", "connection", "content-length", "transfer-encoding"]);
// Bun's fetch already decompressed the body, so echoing the upstream encoding makes the
// client fail with ZlibError and retry the whole turn.
const STRIP_RESPONSE = new Set(["content-encoding", "content-length"]);

// The token never reaches the log: it is replaced before anything is written.
function redactHeaders(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    if (k === "authorization") out[k] = `Bearer <redacted len=${v.length - 7}>`;
    else if (k === "x-api-key") out[k] = "<redacted>";
    else out[k] = v;
  }
  return out;
}

// metadata.user_id carries the account uuid and a device fingerprint: not credentials,
// but account identifiers, and the log outlives the capture.
function redactBody(body: unknown): unknown {
  if (!body || typeof body !== "object") return body;
  const meta = (body as { metadata?: unknown }).metadata;
  if (!meta || typeof meta !== "object") return body;
  if (typeof (meta as { user_id?: unknown }).user_id !== "string") return body;
  return { ...body, metadata: { ...meta, user_id: "<redacted>" } };
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
      headers: redactHeaders(raw),
      body: body ? redactBody(JSON.parse(body)) : undefined,
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
      response: { status: res.status, headers: redactHeaders(Object.fromEntries(res.headers.entries())) },
    }) + "\n");

    const back = new Headers();
    for (const [k, v] of res.headers.entries()) if (!STRIP_RESPONSE.has(k)) back.set(k, v);
    return new Response(res.body, { status: res.status, headers: back });
  },
});
console.log(`proxy up on :${PORT}`);
