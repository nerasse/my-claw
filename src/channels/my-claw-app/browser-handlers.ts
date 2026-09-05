import type { ServerWebSocket } from "bun";
import { homedir } from "node:os";
import { join } from "node:path";
import { readVncPassword } from "../../browser/vnc.ts";
import { BrowserClient } from "../../browser/client.ts";
import { DEFAULT_SIDECAR_URL } from "../../tools/browser/delegate.ts";
import type { BrowserConfig } from "../../core/config.ts";
import type {
  MyClawAppBrowserService,
  MyClawAppBrowserTab,
  MyClawAppErrorScope,
  MyClawAppServerFrame,
} from "./types.ts";
import type { MyClawAppSessionData } from "./controllers.ts";

/** The units the page reports on. A deployment that names them differently sets
 *  `browser.units`; this list is only what this repo's own installer creates. */
const DEFAULT_UNITS = [
  "my-claw-xvfb",
  "my-claw-chromium",
  "my-claw-browser-sidecar",
  "my-claw-vnc",
  "my-claw-novnc",
];

const DEFAULT_VNC_PORT = 5900;

export interface MyClawAppBrowserDeps {
  readonly browser?: BrowserConfig;
  sendFrame(ws: ServerWebSocket<MyClawAppSessionData> | undefined, frame: MyClawAppServerFrame): void;
  refuse(
    ws: ServerWebSocket<MyClawAppSessionData>,
    scope: MyClawAppErrorScope,
    message: string,
    data?: Record<string, unknown>,
  ): Promise<void>;
}

function vncPasswordPath(browser?: BrowserConfig): string {
  return browser?.vncPasswordFile ?? join(homedir(), ".vnc", "passwd");
}

/** The host a native VNC client dials, taken from the same URL the web client uses so the two
 *  cannot name different machines. */
function vncHostFrom(webUrl?: string): string | undefined {
  if (!webUrl) return undefined;
  try {
    return new URL(webUrl).hostname || undefined;
  } catch {
    return undefined;
  }
}

async function unitActive(unit: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(["systemctl", "is-active", unit], { stdout: "pipe", stderr: "ignore" });
    const out = (await new Response(proc.stdout).text()).trim();
    await proc.exited;
    return out === "active";
  } catch {
    // No systemd, or systemctl is not on PATH: reported as down rather than crashing the page.
    return false;
  }
}

async function readServices(units: string[]): Promise<MyClawAppBrowserService[]> {
  const states = await Promise.all(units.map(unitActive));
  return units.map((unit, i) => ({ unit, active: states[i] ?? false }));
}

/**
 * Everything the page needs in one answer: where to connect, with what password, what is running
 * and what is open. The tabs are fetched last and their failure is reported in-band -- a sidecar
 * that is down is exactly when someone opens this page, and refusing the whole frame would hide
 * the service list that says why.
 */
export async function handleBrowserInfo(
  d: MyClawAppBrowserDeps,
  ws: ServerWebSocket<MyClawAppSessionData>,
): Promise<void> {
  try {
    const browser = d.browser;
    const webUrl = browser?.novncUrl;
    const [password, services] = await Promise.all([
      readVncPassword(vncPasswordPath(browser)),
      readServices(browser?.units ?? DEFAULT_UNITS),
    ]);

    let tabs: MyClawAppBrowserTab[] = [];
    let tabsError: string | undefined;
    if (browser?.enabled) {
      try {
        const client = new BrowserClient(
          browser.sidecarUrl ?? DEFAULT_SIDECAR_URL,
          browser.viewport,
          browser.timeoutsMs,
        );
        tabs = (await client.listTabs()).map((t) => ({ id: t.id, title: t.title, url: t.url }));
      } catch (err) {
        tabsError = String(err);
      }
    }

    d.sendFrame(ws, {
      type: "browser.info.result",
      enabled: browser?.enabled === true,
      webUrl,
      vncHost: vncHostFrom(webUrl),
      vncPort: DEFAULT_VNC_PORT,
      password: password ?? undefined,
      services,
      tabs,
      tabsError,
    });
  } catch (err) {
    await d.refuse(ws, "browser", "browser.info failed", { error: String(err) });
  }
}
