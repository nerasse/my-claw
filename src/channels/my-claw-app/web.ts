import { join, normalize, resolve, sep } from "node:path";
import { MY_CLAW_DIR, type MyClawAppChannelConfig } from "../../core/config.ts";

/**
 * Serving the web client bundle off the channel's own HTTP server.
 *
 * The bundle is private: it is handed to a paired client only, like everything else on this
 * port. It holds no secret, but an unauthenticated copy of the UI is a free map of the surface.
 * The browser presents a cookie (web-session.ts) because it cannot append a query token to an
 * asset graph, a service worker or an `<img src>`.
 */

export function webEnabled(config: MyClawAppChannelConfig): boolean {
  return config.web?.enabled === true;
}

export function webDir(config: MyClawAppChannelConfig): string {
  return config.web?.dir ?? join(MY_CLAW_DIR, "web", "current");
}

/**
 * Content-Security-Policy is the reason no third-party script can ever run in a page that holds
 * a session cookie, and no-referrer keeps media URLs (token in the query string) out of the
 * Referer header of anything the page links to.
 */
const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
};

export function securityHeaders(extra?: Record<string, string>): Record<string, string> {
  return { ...SECURITY_HEADERS, ...extra };
}

/**
 * Resolves a URL path inside the bundle directory.
 *
 * A `..` in a URL is a request to read config.json, so the resolved path is compared with the
 * root it must stay under rather than trusting the normalisation alone.
 */
export function resolveBundlePath(dir: string, pathname: string): string | undefined {
  const decoded = (() => {
    try {
      return decodeURIComponent(pathname);
    } catch {
      return undefined;
    }
  })();
  if (decoded === undefined || decoded.includes("\0")) return undefined;

  const root = resolve(dir);
  const target = resolve(join(root, normalize(decoded)));
  if (target !== root && !target.startsWith(root + sep)) return undefined;
  return target;
}

/** Content-hashed asset names never change, so they are cached hard; index.html never is. */
function cacheHeaderFor(pathname: string): string {
  if (pathname.startsWith("/assets/")) return "private, max-age=31536000, immutable";
  return "private, no-cache";
}

/**
 * Serves a file from the bundle, falling back to index.html so a deep link reaches the client
 * router instead of a 404. Returns undefined when the bundle is not installed.
 */
export async function serveBundle(
  config: MyClawAppChannelConfig,
  pathname: string,
): Promise<Response | undefined> {
  const dir = webDir(config);
  const target = resolveBundlePath(dir, pathname === "/" ? "/index.html" : pathname);
  if (!target) return new Response("Not Found", { status: 404, headers: securityHeaders() });

  const file = Bun.file(target);
  if (await file.exists()) {
    return new Response(file, {
      headers: securityHeaders({
        "Cache-Control": cacheHeaderFor(pathname),
        "Content-Type": file.type || "application/octet-stream",
      }),
    });
  }

  // An asset that is missing is missing: only navigation falls through to the shell, or a stale
  // service worker request would be answered with HTML and cached as JavaScript.
  if (pathname.startsWith("/assets/")) {
    return new Response("Not Found", { status: 404, headers: securityHeaders() });
  }

  const index = Bun.file(join(resolve(dir), "index.html"));
  if (!(await index.exists())) return undefined;
  return new Response(index, {
    headers: securityHeaders({ "Cache-Control": "private, no-cache", "Content-Type": "text/html; charset=utf-8" }),
  });
}

/**
 * Whether the request reached us over TLS, which decides the `Secure` cookie attribute.
 *
 * `X-Forwarded-Proto` is only believed from a configured proxy: a client on the LAN would
 * otherwise talk the server into a Secure cookie on a connection that never had TLS.
 */
export function requestIsSecure(
  config: MyClawAppChannelConfig,
  url: URL,
  headers: Headers,
  remoteAddress: string | undefined,
): boolean {
  if (url.protocol === "https:") return true;
  if (!trusted(config, remoteAddress)) return false;
  return headers.get("x-forwarded-proto")?.split(",")[0]?.trim() === "https";
}

/** The host the browser used, which is what an Origin must match. */
export function requestHost(
  config: MyClawAppChannelConfig,
  url: URL,
  headers: Headers,
  remoteAddress: string | undefined,
): string {
  if (trusted(config, remoteAddress)) {
    const forwarded = headers.get("x-forwarded-host")?.split(",")[0]?.trim();
    if (forwarded) return forwarded;
  }
  return headers.get("host") ?? url.host;
}

/** The client address, for logs and the per-IP pairing limit. */
export function clientIp(
  config: MyClawAppChannelConfig,
  headers: Headers,
  remoteAddress: string | undefined,
): string | undefined {
  if (trusted(config, remoteAddress)) {
    const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
    if (forwarded) return forwarded;
  }
  return remoteAddress;
}

function trusted(config: MyClawAppChannelConfig, remoteAddress: string | undefined): boolean {
  const cidrs = config.web?.trustedProxies ?? [];
  if (cidrs.length === 0 || !remoteAddress) return false;
  return cidrs.some((cidr) => addressInCidr(remoteAddress, cidr));
}

/**
 * IPv4 CIDR match, and an exact string match for anything else.
 *
 * A full IPv6 implementation would be dead weight here: a proxy is declared by the owner, and
 * an exact address covers the one case this deployment has.
 */
export function addressInCidr(address: string, cidr: string): boolean {
  if (!cidr.includes("/")) return address === cidr;
  const [range, bitsRaw] = cidr.split("/");
  const bits = Number(bitsRaw);
  if (!range || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;

  const left = ipv4ToInt(address);
  const right = ipv4ToInt(range);
  if (left === undefined || right === undefined) return false;
  if (bits === 0) return true;
  const mask = bits === 32 ? 0xffffffff : (0xffffffff << (32 - bits)) >>> 0;
  return (left & mask) === (right & mask);
}

function ipv4ToInt(address: string): number | undefined {
  const parts = address.split(".");
  if (parts.length !== 4) return undefined;
  let value = 0;
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return undefined;
    value = ((value << 8) | octet) >>> 0;
  }
  return value;
}
