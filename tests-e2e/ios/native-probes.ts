if (process.env.MYCLAW_IOS_PROBES !== "1") throw new Error("Set MYCLAW_IOS_PROBES=1 for isolated localhost probes");

function hasNativeCredentials(request: Request): boolean {
  const url = new URL(request.url);
  return !url.searchParams.has("token") && !url.searchParams.has("device") &&
    request.headers.get("x-my-claw-device") === "fixture" &&
    request.headers.get("authorization") === "Bearer fixture-token";
}

const socket = Bun.serve({ hostname: "127.0.0.1", port: 0,
  fetch(request, server) {
    if (new URL(request.url).pathname === "/reject") return new Response("unauthorized", { status: 401 });
    if (!hasNativeCredentials(request)) return new Response("native headers required", { status: 401 });
    if (server.upgrade(request)) return;
    return new Response("probe only", { status: 400 });
  },
  websocket: { message(socket, message) { if (message === "probe") socket.send("probe reply"); } }
});
const media = Bun.serve({ hostname: "127.0.0.1", port: 0,
  async fetch(request) {
    if (!hasNativeCredentials(request)) return new Response("native headers required", { status: 401 });
    const path = new URL(request.url).pathname;
    if (path === "/upload") {
      const body = await request.arrayBuffer();
      return Response.json({ filename: request.headers.get("x-filename"), type: request.headers.get("x-type"),
        thread: request.headers.get("x-thread-id"), size: String(body.byteLength) });
    }
    if (path === "/download") return new Response("native download fixture");
    return new Response("missing fixture", { status: 404 });
  }
});
const addresses = { MYCLAW_IOS_WS_PROBE_URL: `ws://127.0.0.1:${socket.port}`,
  MYCLAW_IOS_MEDIA_PROBE_URL: `http://127.0.0.1:${media.port}` };
console.info(JSON.stringify(addresses));
const stop = () => { void Promise.all([socket.stop(true), media.stop(true)]).then(() => process.exit(0)); };
process.once("SIGINT", stop); process.once("SIGTERM", stop);
