import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Forgejo, route } from "../../relay/forgejo.ts";
import { KeyStore } from "../../relay/keys.ts";
import { createRelay, type LogEntry } from "../../relay/relay.ts";

const TOKEN = "forgejo-read-token";
const SECRET = "proxy-secret";
const PUBLIC = "https://dl.example.test";
const TARBALL = new Uint8Array(1000).map((_, i) => i % 251);

let upstreamCalls: string[] = [];
let refuseToken = false;

const fake = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const url = new URL(req.url);
    upstreamCalls.push(`${req.method} ${url.pathname}${url.search}`);
    if (refuseToken || req.headers.get("authorization") !== `token ${TOKEN}`) {
      return new Response("Not found.", { status: 404 });
    }
    const p = url.pathname;
    if (p === "/api/v1/packages/claw") {
      return Response.json([
        { name: "my-claw", type: "generic", version: "0.7.9" },
        { name: "my-claw", type: "generic", version: "0.7.10" },
        { name: "other", type: "generic", version: "9.9.9" },
        { name: "my-claw", type: "container", version: "8.0.0" },
      ]);
    }
    if (p === "/api/v1/packages/claw/generic/my-claw/0.7.10/files") {
      // The real payload, shape and capital S included (Forgejo 16, 2026-10-07).
      return Response.json([{ Size: TARBALL.length, id: 417, md5: "m", name: "my-claw-0.7.10-linux-x64.tar.gz", sha1: "s1", sha256: "abc", sha512: "s5" }]);
    }
    if (p === "/api/packages/claw/generic/my-claw/0.7.10/my-claw-0.7.10-linux-x64.tar.gz") {
      if (req.method === "HEAD") return new Response(null, { status: 405 });
      const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.get("range") ?? "");
      if (range) {
        const [from, to] = [Number(range[1]), Number(range[2])];
        return new Response(TARBALL.slice(from, to + 1), {
          status: 206,
          headers: { "content-range": `bytes ${from}-${to}/${TARBALL.length}` },
        });
      }
      return new Response(TARBALL);
    }
    if (p === "/api/v1/repos/claw/my-claw-app/releases") {
      return Response.json([
        { tag_name: "v0.6.12", draft: false, prerelease: false, published_at: "2026-10-01T00:00:00Z",
          assets: [{ name: "my-claw-app-v0.6.12.apk", size: 42 }, { name: "dist-web.tar.gz", size: 7 }] },
        { tag_name: "v0.6.13", draft: true, prerelease: false, published_at: "2026-10-02T00:00:00Z",
          assets: [{ name: "my-claw-app-v0.6.13.apk", size: 43 }] },
        { tag_name: "v0.6.9", draft: false, prerelease: false, published_at: "2026-10-03T00:00:00Z",
          assets: [{ name: "my-claw-app-v0.6.9.apk", size: 41 }] },
      ]);
    }
    if (p === "/claw/my-claw-app/releases/download/v0.6.12/my-claw-app-v0.6.12.apk") return new Response("apk-bytes");
    if (p === "/api/v1/repos/claw/my-claw/raw/packaging/install-remote.sh" && url.searchParams.get("ref") === "v0.7.10") {
      return new Response("#!/bin/sh\necho install\n");
    }
    return new Response("Not found.", { status: 404 });
  },
});

let dir: string;
let keys: KeyStore;
let logs: LogEntry[];
let relay: (req: Request) => Promise<Response>;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "relay-"));
});

afterAll(() => {
  fake.stop(true);
});

beforeEach(async () => {
  upstreamCalls = [];
  refuseToken = false;
  logs = [];
  keys = await KeyStore.open(join(dir, `keys-${crypto.randomUUID()}.json`));
  relay = createRelay({
    forgejo: new Forgejo(`http://127.0.0.1:${fake.port}`, TOKEN),
    keys,
    proxySecret: SECRET,
    admins: ["neras"],
    publicUrl: PUBLIC,
    log: (e) => logs.push(e),
  });
});

const get = (path: string, headers: Record<string, string> = {}, method = "GET") =>
  relay(new Request(`${PUBLIC}${path}`, { method, headers }));

async function keyFor(user: string, label = "pc"): Promise<string> {
  return (await keys.create(user, label)).key;
}

const signedIn = (user: string) => ({ "x-relay-user": user, "x-relay-secret": SECRET });

function post(path: string, user: string, form: Record<string, string>, origin = PUBLIC) {
  return relay(new Request(`${PUBLIC}${path}`, {
    method: "POST",
    headers: { ...signedIn(user), origin },
    body: new URLSearchParams(form),
  }));
}

describe("downloads", () => {
  test("no key, a wrong key or another scheme is refused before Forgejo is asked anything", async () => {
    const key = await keyFor("amine");
    const attempts: Array<Record<string, string>> = [{}, { authorization: "Bearer mcr_wrong" }, { authorization: `token ${key}` }];
    for (const headers of attempts) {
      const res = await get("/server/latest.json", headers);
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe("Bearer");
    }
    expect(upstreamCalls).toEqual([]);
  });

  test("the newest server release is the highest version of the generic my-claw package", async () => {
    const key = await keyFor("amine");
    const res = await get("/server/latest.json", { authorization: `Bearer ${key}` });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      version: "0.7.10",
      file: "my-claw-0.7.10-linux-x64.tar.gz",
      size: TARBALL.length,
      sha256: "abc",
    });
  });

  test("a tarball streams through, and a range is passed on", async () => {
    const auth = { authorization: `Bearer ${await keyFor("amine")}` };
    const full = await get("/server/0.7.10/my-claw-0.7.10-linux-x64.tar.gz", auth);
    expect(full.status).toBe(200);
    expect(new Uint8Array(await full.arrayBuffer())).toEqual(TARBALL);

    const part = await get("/server/0.7.10/my-claw-0.7.10-linux-x64.tar.gz", { ...auth, range: "bytes=10-19" });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe(`bytes 10-19/${TARBALL.length}`);
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(TARBALL.slice(10, 20));
  });

  test("HEAD reports the full size even though the registry answers 405 to it", async () => {
    const auth = { authorization: `Bearer ${await keyFor("amine")}` };
    const res = await get("/server/0.7.10/my-claw-0.7.10-linux-x64.tar.gz", auth, "HEAD");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe(String(TARBALL.length));
    expect(upstreamCalls).toEqual(["GET /api/packages/claw/generic/my-claw/0.7.10/my-claw-0.7.10-linux-x64.tar.gz"]);
  });

  test("the newest app release skips drafts and compares versions, not dates", async () => {
    const auth = { authorization: `Bearer ${await keyFor("amine")}` };
    const res = await get("/app/latest.json", auth);
    expect(await res.json()).toEqual({ version: "0.6.12", apkSize: 42, web: true, publishedAt: "2026-10-01T00:00:00Z" });
    const apk = await get("/app/0.6.12/my-claw-app-v0.6.12.apk", auth);
    expect(apk.headers.get("content-type")).toBe("application/vnd.android.package-archive");
    expect(await apk.text()).toBe("apk-bytes");
  });

  test("the installer is taken at the newest server tag", async () => {
    const res = await get("/install.sh", { authorization: `Bearer ${await keyFor("amine")}` });
    expect(await res.text()).toBe("#!/bin/sh\necho install\n");
  });

  test("only the listed paths reach Forgejo, whatever the key", async () => {
    const auth = { authorization: `Bearer ${await keyFor("amine")}` };
    const paths = [
      "/api/v1/packages/claw",
      "/server/0.7.10/my-claw-0.7.9-linux-x64.tar.gz",
      "/server/../api/v1/user/my-claw-0.7.10-linux-x64.tar.gz",
      "/server/0.7.10%2F..%2F/my-claw-0.7.10-linux-x64.tar.gz",
      "/app/0.6.12/other.apk",
      "/claw/my-claw/raw/main/src/index.ts",
    ];
    for (const path of paths) expect((await get(path, auth)).status).toBe(404);
    expect(upstreamCalls).toEqual([]);
    expect((await get("/server/latest.json", auth, "POST")).status).toBe(405);
  });

  test("a missing file is a 404, a refused token a 502 that names the cause in the log", async () => {
    const auth = { authorization: `Bearer ${await keyFor("amine")}` };
    expect((await get("/server/0.7.11/my-claw-0.7.11-linux-x64.tar.gz", auth)).status).toBe(404);
    expect((await get("/server/0.7.11/my-claw-0.7.11-linux-x64.tar.gz", auth, "HEAD")).status).toBe(404);
    refuseToken = true;
    expect((await get("/server/latest.json", auth)).status).toBe(502);
    expect(logs.at(-1)).toMatchObject({ status: 502, error: "forgejo answered 404 on /api/v1/packages/claw?type=generic&q=my-claw&limit=50" });
  });

  test("every request is logged with the person and the key id, never the key", async () => {
    const key = await keyFor("amine");
    await get("/app/latest.json", { authorization: `Bearer ${key}` });
    const [record] = keys.list("amine");
    expect(logs).toEqual([
      expect.objectContaining({ method: "GET", path: "/app/latest.json", status: 200, user: "amine", key: record!.id }),
    ]);
    expect(JSON.stringify(logs)).not.toContain(key);
  });
});

describe("the key page", () => {
  test("the root leads to it, and health needs nothing", async () => {
    const root = await get("/");
    expect(root.status).toBe(302);
    expect(root.headers.get("location")).toBe("/key");
    expect(await (await get("/health")).text()).toBe("ok");
    expect(upstreamCalls).toEqual([]);
    expect(logs.map((e) => e.path)).toEqual(["/"]);
  });

  test("is only served with the proxy's secret and a user", async () => {
    expect((await get("/key")).status).toBe(403);
    expect((await get("/key", { "x-relay-user": "amine" })).status).toBe(403);
    expect((await get("/key", { "x-relay-user": "amine", "x-relay-secret": "guess" })).status).toBe(403);
    expect((await get("/key", { "x-relay-secret": SECRET })).status).toBe(403);
    const page = await get("/key", signedIn("amine"));
    expect(page.status).toBe(200);
    expect(page.headers.get("cache-control")).toBe("no-store");
  });

  test("a created key is shown once, works at once, and only its hash is stored", async () => {
    const res = await post("/key", "amine", { label: "VPS <maison>" });
    const page = await res.text();
    const key = /mcr_[A-Za-z0-9_-]{43}/.exec(page)?.[0];
    expect(key).toBeDefined();
    expect(page).toContain("VPS &#60;maison&#62;");
    expect(page).toContain(`${PUBLIC}/install.sh`);

    expect((await get("/app/latest.json", { authorization: `Bearer ${key}` })).status).toBe(200);
    const again = await (await get("/key", signedIn("amine"))).text();
    expect(again).not.toContain(key!);
  });

  test("the key file holds hashes, is private, and is read back by a new relay", async () => {
    const file = join(dir, "persist.json");
    const store = await KeyStore.open(file);
    const { key } = await store.create("lastry", "laptop");
    const raw = await readFile(file, "utf8");
    expect(raw).not.toContain(key);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await KeyStore.open(file)).byKey(key)?.user).toBe("lastry");
  });

  test("a key that cannot be written is not handed out", async () => {
    const store = await KeyStore.open(join(dir, "missing-dir", "keys.json"));
    await expect(store.create("amine", "pc")).rejects.toThrow();
    expect(store.list()).toEqual([]);
  });

  test("a person holds twenty keys at most", async () => {
    for (let i = 0; i < 20; i++) await keyFor("amine", `pc ${i}`);
    const res = await post("/key", "amine", { label: "one more" });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("at most 20 keys per person");
    expect(keys.list("amine")).toHaveLength(20);
  });

  test("a POST from another site is refused", async () => {
    expect((await post("/key", "amine", { label: "x" }, "https://evil.test")).status).toBe(403);
    expect(keys.list()).toEqual([]);
  });

  test("a machine name is required", async () => {
    expect((await post("/key", "amine", { label: "  " })).status).toBe(400);
    expect((await post("/key", "amine", { label: "x".repeat(61) })).status).toBe(400);
    expect(keys.list()).toEqual([]);
  });

  test("a revoked key stops working at once; someone else's key cannot be revoked", async () => {
    const key = await keyFor("amine");
    const [mine] = keys.list("amine");
    expect((await post("/key/revoke", "lastry", { id: mine!.id })).status).toBe(404);
    expect((await get("/app/latest.json", { authorization: `Bearer ${key}` })).status).toBe(200);

    const res = await post("/key/revoke", "amine", { id: mine!.id });
    expect(res.status).toBe(303);
    expect((await get("/app/latest.json", { authorization: `Bearer ${key}` })).status).toBe(401);
  });

  test("an admin sees everyone's keys and can revoke them", async () => {
    await keyFor("amine", "amine-pc");
    const before = await (await get("/key", signedIn("neras"))).text();
    expect(before).toContain("amine-pc");
    expect(await (await get("/key", signedIn("lastry"))).text()).not.toContain("amine-pc");

    const [record] = keys.list("amine");
    expect((await post("/key/revoke", "neras", { id: record!.id })).status).toBe(303);
    expect(keys.list("amine")).toEqual([]);
  });
});

describe("routes", () => {
  test("a version must be three numbers, the same in the directory and the file name", () => {
    expect(route("/server/0.7.10/my-claw-0.7.10-linux-x64.tar.gz")).toMatchObject({ kind: "file" });
    expect(route("/server/0.7/my-claw-0.7-linux-x64.tar.gz")).toBeUndefined();
    expect(route("/app/0.6.1/my-claw-app-v0.6.2.apk")).toBeUndefined();
    expect(route("/app/0.6.1/dist-web.tar.gz")).toMatchObject({
      upstream: "/claw/my-claw-app/releases/download/v0.6.1/dist-web.tar.gz",
    });
  });
});
