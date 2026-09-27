import { describe, expect, test } from "bun:test";
import { BrowserCast, CAST_PRESETS, type CastEvent, type CastSocket } from "../../src/browser/cast.ts";

/** A sidecar socket in memory: what the relay sent it, and a way to answer. */
class FakeSocket implements CastSocket {
  readyState = 0;
  sent: string[] = [];
  closed = false;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  constructor(readonly url: string) {}
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
    this.readyState = 3;
    this.onclose?.({});
  }
  accept(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  drop(): void {
    this.readyState = 3;
    this.onclose?.({});
  }
  frame(pageId: string, data = "AAAA", width = 1280, height = 720): void {
    this.onmessage?.({ data: JSON.stringify({ type: "frame", pageId, data, width, height }) });
  }
  watched(): Array<{ pageId: string; fps: number; maxWidth: number }> {
    const last = this.sent.at(-1);
    return last ? (JSON.parse(last) as { streams: Array<{ pageId: string; fps: number; maxWidth: number }> }).streams : [];
  }
}

function relay() {
  const sockets: FakeSocket[] = [];
  const cast = new BrowserCast(() => "http://127.0.0.1:9223", (url) => {
    const s = new FakeSocket(url);
    sockets.push(s);
    return s;
  });
  return { cast, sockets, current: () => sockets.at(-1)! };
}

function collector() {
  const events: CastEvent[] = [];
  return { events, deliver: (e: CastEvent) => events.push(e), frames: () => events.filter((e) => e.type === "frame") };
}

describe("BrowserCast", () => {
  test("nothing connects until someone watches, and the socket is the sidecar's /cast", () => {
    const { cast, sockets } = relay();
    expect(sockets.length).toBe(0);
    cast.watch({}, [{ pageId: "p1", preset: "tile" }], () => undefined);
    expect(sockets.length).toBe(1);
    expect(sockets[0]!.url).toBe("ws://127.0.0.1:9223/cast");
  });

  test("the sidecar is asked for every watched tab once, at the largest size anyone wants", () => {
    const { cast, current } = relay();
    const phone = {};
    const desk = {};
    cast.watch(phone, [{ pageId: "p1", preset: "tile" }, { pageId: "p2", preset: "tile" }], () => undefined);
    current().accept();
    expect(current().watched()).toEqual([
      { pageId: "p1", ...CAST_PRESETS.tile },
      { pageId: "p2", ...CAST_PRESETS.tile },
    ]);
    cast.watch(desk, [{ pageId: "p1", preset: "focus" }], () => undefined);
    expect(current().watched().find((s) => s.pageId === "p1")).toEqual({ pageId: "p1", ...CAST_PRESETS.focus });

    // The full view closes: the tile keeps its stream, back at tile size.
    cast.unwatch(desk);
    expect(current().watched().find((s) => s.pageId === "p1")).toEqual({ pageId: "p1", ...CAST_PRESETS.tile });
  });

  // The order the devices came in must not matter: tested both ways.
  test("a tile watched after a full view never shrinks it", () => {
    const { cast, current } = relay();
    const desk = {};
    const phone = {};
    cast.watch(desk, [{ pageId: "p1", preset: "focus" }], () => undefined);
    current().accept();
    cast.watch(phone, [{ pageId: "p1", preset: "tile" }], () => undefined);
    expect(current().watched()).toEqual([{ pageId: "p1", ...CAST_PRESETS.focus }]);
    cast.unwatch(desk);
    expect(current().watched()).toEqual([{ pageId: "p1", ...CAST_PRESETS.tile }]);
  });

  test("the same request is not sent twice", () => {
    const { cast, current } = relay();
    const w = {};
    cast.watch(w, [{ pageId: "p1", preset: "tile" }], () => undefined);
    current().accept();
    cast.watch(w, [{ pageId: "p1", preset: "tile" }], () => undefined);
    expect(current().sent.length).toBe(1);
  });

  test("a frame reaches the watchers of its tab and no one else", () => {
    const { cast, current } = relay();
    const a = collector();
    const b = collector();
    cast.watch({}, [{ pageId: "p1", preset: "tile" }], a.deliver);
    cast.watch({}, [{ pageId: "p2", preset: "tile" }], b.deliver);
    current().accept();
    current().frame("p1", "ONE");
    expect(a.frames().length).toBe(1);
    expect(b.frames().length).toBe(0);
    const event = a.frames()[0]!;
    expect(event.type === "frame" && event.frame).toMatchObject({ pageId: "p1", data: "ONE", width: 1280, height: 720 });
  });

  // A page that does not change sends nothing: a new watcher would wait forever.
  test("a new watcher of a still page gets its last picture at once", () => {
    const { cast, current } = relay();
    cast.watch({}, [{ pageId: "p1", preset: "tile" }], () => undefined);
    current().accept();
    current().frame("p1", "STILL");
    const late = collector();
    cast.watch({}, [{ pageId: "p1", preset: "focus" }], late.deliver);
    expect(late.frames().length).toBe(1);
    const event = late.frames()[0]!;
    expect(event.type === "frame" && event.frame.data).toBe("STILL");
  });

  test("a closed tab is announced to its watchers", () => {
    const { cast, current } = relay();
    const a = collector();
    cast.watch({}, [{ pageId: "p1", preset: "tile" }], a.deliver);
    current().accept();
    current().onmessage?.({ data: JSON.stringify({ type: "gone", pageId: "p1" }) });
    expect(a.events).toEqual([{ type: "gone", pageId: "p1" }]);
  });

  test("the last watcher leaving closes the socket", () => {
    const { cast, current } = relay();
    const w = {};
    cast.watch(w, [{ pageId: "p1", preset: "tile" }], () => undefined);
    current().accept();
    cast.watch(w, [], () => undefined);
    expect(current().closed).toBe(true);
  });

  test("a sidecar that goes away is dialed again, and told the streams again", async () => {
    const { cast, sockets, current } = relay();
    cast.watch({}, [{ pageId: "p1", preset: "tile" }], () => undefined);
    current().accept();
    current().drop();
    await Bun.sleep(1100);
    expect(sockets.length).toBe(2);
    current().accept();
    expect(current().watched().map((s) => s.pageId)).toEqual(["p1"]);
  });
});
