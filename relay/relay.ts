import { timingSafeEqual } from "node:crypto";
import { Forgejo, UpstreamError, route } from "./forgejo.ts";
import type { KeyStore } from "./keys.ts";
import { LABEL_MAX, hashKey } from "./keys.ts";
import { keysPage, refusedPage } from "./page.ts";

export interface LogEntry {
  t: string;
  method: string;
  path: string;
  status: number;
  user?: string;
  key?: string;
  error?: string;
}

export interface RelayOptions {
  forgejo: Forgejo;
  keys: KeyStore;
  /** Set by the proxy on /key only, after the Keycloak sign-in: proves the user header is its own. */
  proxySecret: string;
  admins: string[];
  publicUrl: string;
  /** How long a collaborator check holds. A removed collaborator is cut off within this delay. */
  accessTtlMs?: number;
  log?: (entry: LogEntry) => void;
}

const USER_HEADER = "x-relay-user";
const SECRET_HEADER = "x-relay-secret";

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json", "cache-control": "no-store" } });

const text = (status: number, body: string, headers: Record<string, string> = {}): Response =>
  new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", ...headers } });

const html = (body: string, status = 200): Response =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });

function sameSecret(given: string, expected: string): boolean {
  return timingSafeEqual(Buffer.from(hashKey(given), "hex"), Buffer.from(hashKey(expected), "hex"));
}

function bearer(req: Request): string | undefined {
  const match = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "");
  return match?.[1];
}

/** Total size from a `bytes 0-0/12345` Content-Range, the only way a 206 tells it. */
function totalSize(upstream: Response): string | undefined {
  const range = /\/(\d+)$/.exec(upstream.headers.get("content-range") ?? "");
  return range?.[1] ?? upstream.headers.get("content-length") ?? undefined;
}

async function serveFile(forgejo: Forgejo, req: Request, path: string, type: string): Promise<Response> {
  if (req.method === "HEAD") {
    // The package registry answers 405 to HEAD: ask for one byte and report the full size.
    const upstream = await forgejo.fetch(path, { Range: "bytes=0-0" });
    await upstream.body?.cancel();
    if (upstream.status === 404) return new Response(null, { status: 404 });
    if (!upstream.ok) throw new UpstreamError(upstream.status, `forgejo answered ${upstream.status} on ${path}`);
    const size = totalSize(upstream);
    return new Response(null, {
      headers: { "content-type": type, "accept-ranges": "bytes", ...(size ? { "content-length": size } : {}) },
    });
  }
  const range = req.headers.get("range");
  const upstream = await forgejo.fetch(path, range ? { Range: range } : {});
  if (upstream.status === 404) {
    await upstream.body?.cancel();
    return text(404, "not found");
  }
  if (!upstream.ok) {
    await upstream.body?.cancel();
    throw new UpstreamError(upstream.status, `forgejo answered ${upstream.status} on ${path}`);
  }
  const headers: Record<string, string> = { "content-type": type, "accept-ranges": "bytes" };
  for (const name of ["content-length", "content-range"]) {
    const value = upstream.headers.get(name);
    if (value) headers[name] = value;
  }
  return new Response(upstream.body, { status: upstream.status, headers });
}

export function createRelay(options: RelayOptions): (req: Request) => Promise<Response> {
  const { forgejo, keys, admins, publicUrl } = options;
  const log = options.log ?? ((entry: LogEntry) => console.log(JSON.stringify(entry)));
  const origin = new URL(publicUrl).origin;
  const accessTtl = options.accessTtlMs ?? 5 * 60 * 1000;
  const access = new Map<string, { allowed: boolean; at: number }>();

  async function isCollaborator(user: string): Promise<boolean> {
    const known = access.get(user);
    if (known && Date.now() - known.at < accessTtl) return known.allowed;
    const allowed = await forgejo.isCollaborator(user);
    access.set(user, { allowed, at: Date.now() });
    return allowed;
  }

  async function keyPage(req: Request, path: string, user: string): Promise<Response> {
    const isAdmin = admins.includes(user);
    const page = (extra: { fresh?: { key: string; label: string }; error?: string } = {}, status = 200) =>
      html(keysPage({ user, own: keys.list(user), all: isAdmin ? keys.list() : undefined, publicUrl, ...extra }), status);

    if (req.method === "GET" && path === "/key") return page();
    if (req.method !== "POST") return text(405, "method not allowed");
    // The sign-in cookie rides along on any cross-site POST: only a form from this site may act.
    if (req.headers.get("origin") !== origin) return text(403, "forbidden");
    const form = await req.formData();

    if (path === "/key") {
      const label = String(form.get("label") ?? "").trim();
      if (!label || label.length > LABEL_MAX) return page({ error: `Name the machine (${LABEL_MAX} characters at most).` }, 400);
      try {
        const { key } = await keys.create(user, label);
        return page({ fresh: { key, label } });
      } catch (err) {
        return page({ error: (err as Error).message }, 400);
      }
    }
    if (path === "/key/revoke") {
      const id = String(form.get("id") ?? "");
      const target = keys.list().find((r) => r.id === id);
      if (!target || (target.user !== user && !isAdmin)) return page({ error: "No such key." }, 404);
      await keys.revoke(id);
      return new Response(null, { status: 303, headers: { location: "/key" } });
    }
    return text(404, "not found");
  }

  async function download(req: Request, path: string): Promise<Response> {
    const target = route(path);
    if (!target) return text(404, "not found");
    if (req.method !== "GET" && req.method !== "HEAD") return text(405, "method not allowed");
    switch (target.kind) {
      case "server-latest": {
        const latest = await forgejo.serverLatest();
        return latest ? json(latest) : text(404, "no server release");
      }
      case "app-latest": {
        const latest = await forgejo.appLatest();
        return latest ? json(latest) : text(404, "no app release");
      }
      case "install": {
        const upstream = await forgejo.installer();
        if (!upstream.ok) {
          await upstream.body?.cancel();
          throw new UpstreamError(upstream.status, `forgejo answered ${upstream.status} on the installer`);
        }
        return new Response(upstream.body, { headers: { "content-type": "text/x-shellscript; charset=utf-8" } });
      }
      case "file":
        return serveFile(forgejo, req, target.upstream, target.type);
    }
  }

  return async (req) => {
    const path = new URL(req.url).pathname;
    const entry: LogEntry = { t: new Date().toISOString(), method: req.method, path, status: 0 };
    let response: Response;
    try {
      if (path === "/health") {
        response = text(200, "ok");
      } else if (path === "/") {
        response = new Response(null, { status: 302, headers: { location: "/key" } });
      } else if (path === "/key" || path.startsWith("/key/")) {
        const user = req.headers.get(USER_HEADER) ?? "";
        const secret = req.headers.get(SECRET_HEADER) ?? "";
        if (!secret || !sameSecret(secret, options.proxySecret) || !user) {
          response = text(403, "this page is reached through the sign-in");
        } else {
          entry.user = user;
          response = await isCollaborator(user)
            ? await keyPage(req, path, user)
            : html(refusedPage(user), 403);
        }
      } else {
        const given = bearer(req);
        const record = given ? keys.byKey(given) : undefined;
        if (!record) {
          response = text(401, "a download key is needed", { "www-authenticate": "Bearer" });
        } else {
          entry.user = record.user;
          entry.key = record.id;
          response = await isCollaborator(record.user)
            ? await download(req, path)
            : text(403, "this key's owner no longer has access to my-claw");
        }
      }
    } catch (err) {
      entry.error = (err as Error).message;
      response = text(502, "the release store did not answer");
    }
    entry.status = response.status;
    // The container healthcheck asks every minute: the log is for people.
    if (path !== "/health") log(entry);
    return response;
  };
}
