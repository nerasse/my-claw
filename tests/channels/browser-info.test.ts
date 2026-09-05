import { test, describe, expect } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleBrowserInfo, type MyClawAppBrowserDeps } from "../../src/channels/my-claw-app/browser-handlers.ts";
import type { MyClawAppServerFrame } from "../../src/channels/my-claw-app/types.ts";
import type { MyClawAppSessionData } from "../../src/channels/my-claw-app/controllers.ts";
import type { ServerWebSocket } from "bun";
import { mockFetch } from "../helpers/mock-fetch.ts";

const WS = {} as ServerWebSocket<MyClawAppSessionData>;

async function passwordFile(stored: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "browser-info-"));
  const path = join(dir, "passwd");
  await writeFile(path, Buffer.from(stored, "hex"));
  return path;
}

function collect(): { deps: (browser: MyClawAppBrowserDeps["browser"]) => MyClawAppBrowserDeps; sent: MyClawAppServerFrame[]; refusals: string[] } {
  const sent: MyClawAppServerFrame[] = [];
  const refusals: string[] = [];
  return {
    sent,
    refusals,
    deps: (browser) => ({
      browser,
      sendFrame: (_ws, frame) => void sent.push(frame),
      refuse: async (_ws, _scope, message) => void refusals.push(message),
    }),
  };
}

function result(frames: MyClawAppServerFrame[]) {
  const frame = frames[0];
  if (!frame || frame.type !== "browser.info.result") throw new Error(`not an info result: ${frame?.type}`);
  return frame;
}

describe("browser.info", () => {
  test("hands over the password the file holds, and the host the web URL names", async () => {
    const { deps, sent } = collect();
    await handleBrowserInfo(
      deps({ enabled: false, novncUrl: "http://10.10.20.10:6080/vnc.html?autoconnect=1", vncPasswordFile: await passwordFile("70685069802a5e92"), units: [] }),
      WS,
    );
    const frame = result(sent);
    expect(frame.password).toBe("test1234");
    // The native client dials the same machine as the web one; two fields, one source.
    expect(frame.vncHost).toBe("10.10.20.10");
    expect(frame.vncPort).toBe(5900);
  });

  test("says the password is absent rather than inventing one", async () => {
    const { deps, sent } = collect();
    await handleBrowserInfo(deps({ enabled: false, vncPasswordFile: "/no/such/passwd", units: [] }), WS);
    const frame = result(sent);
    expect(frame.password).toBeUndefined();
    expect(frame.vncHost).toBeUndefined();
  });

  test("a sidecar that is down still answers, with the failure named", async () => {
    // This is the state someone opens the page in. Refusing the frame would withhold the service
    // list that explains why the browser is unreachable.
    const mock = mockFetch(async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:9223");
    });
    try {
      const { deps, sent, refusals } = collect();
      await handleBrowserInfo(deps({ enabled: true, sidecarUrl: "http://127.0.0.1:9223", units: [] }), WS);
      const frame = result(sent);
      expect(refusals).toEqual([]);
      expect(frame.tabs).toEqual([]);
      expect(frame.tabsError).toContain("ECONNREFUSED");
    } finally {
      mock.restore();
    }
  });

  test("a disabled browser is never dialled", async () => {
    let calls = 0;
    const mock = mockFetch(async () => {
      calls += 1;
      return new Response("{}", { status: 200 });
    });
    try {
      const { deps, sent } = collect();
      await handleBrowserInfo(deps({ enabled: false, units: [] }), WS);
      expect(result(sent).enabled).toBe(false);
      expect(calls).toBe(0);
    } finally {
      mock.restore();
    }
  });

  test("a unit that does not exist reports as down instead of throwing", async () => {
    const { deps, sent, refusals } = collect();
    await handleBrowserInfo(deps({ enabled: false, units: ["my-claw-does-not-exist"] }), WS);
    expect(refusals).toEqual([]);
    expect(result(sent).services).toEqual([{ unit: "my-claw-does-not-exist", active: false }]);
  });
});
