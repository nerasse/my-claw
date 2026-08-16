import { readFile } from "node:fs/promises";
import { CONFIG_PATH, type MyClawAppChannelConfig, type MyClawConfig } from "../../core/config.ts";
import { listDevices, mintDevice, revokeDevice, setDeviceEnabled } from "./devices.ts";

/**
 * `myclaw device`: the shell-side half of pairing (docs/web-pairing.md).
 *
 * It writes the device itself, because the config file is the source of truth and the CLI can
 * reach it whether or not the daemon is up. The claim code is a different matter: a ticket lives
 * in the daemon's memory, so it is asked for over the channel's own port, authenticated with the
 * credential that was just minted.
 */

const USAGE = `usage: myclaw device <command>

  add --name <name> [--owner <owner>] [--kind web|app]   mint a device and print a claim link
  ls                                                     list paired devices
  rm <deviceId>                                          revoke a device
  disable <deviceId> | enable <deviceId>                 keep the entry, close or open the door
`;

interface ParsedArgs {
  positional: string[];
  flags: Record<string, string>;
}

function parseArgs(args: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith("--")) {
      const [name, inline] = arg.slice(2).split("=", 2);
      if (!name) continue;
      if (inline !== undefined) {
        flags[name] = inline;
      } else {
        flags[name] = args[i + 1] ?? "";
        i += 1;
      }
      continue;
    }
    positional.push(arg);
  }
  return { positional, flags };
}

async function readChannelConfig(): Promise<{ channel: MyClawAppChannelConfig; port: number }> {
  const raw = await readFile(CONFIG_PATH, "utf-8").catch(() => "{}");
  let parsed: MyClawConfig | undefined;
  try {
    parsed = JSON.parse(raw) as MyClawConfig;
  } catch {
    // A broken config is reported by the write path, which refuses to touch it.
  }
  const channel = (parsed?.channels?.["my-claw-app"] ?? {}) as MyClawAppChannelConfig;
  return { channel, port: channel.port ?? 8080 };
}

/**
 * Asks the running daemon for a claim code. A failure here is not a failure of `add`: the device
 * exists, and the token was printed. Only the convenience link is lost.
 */
async function requestTicket(
  port: number,
  deviceId: string,
  token: string,
): Promise<{ code: string; host: string } | { error: string }> {
  const url = `http://127.0.0.1:${port}/my-claw-app/ticket?device=${encodeURIComponent(deviceId)}&token=${encodeURIComponent(token)}`;
  // The device exists on disk, but the daemon is another process and learns about it through its
  // config watcher, which debounces. Asking once answers 401 for a credential that is perfectly
  // valid, so the call waits for the reload instead of reporting a failure that is only early.
  let last = "the daemon is not reachable";
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const response = await fetch(url, { method: "POST", signal: AbortSignal.timeout(5000) });
      if (response.status === 409) return { error: "pairing is disabled in the config" };
      if (response.ok) {
        const body = (await response.json()) as { code?: string; host?: string };
        if (!body.code) return { error: "daemon returned no code" };
        return { code: body.code, host: body.host ?? `127.0.0.1:${port}` };
      }
      last = `daemon answered ${response.status}`;
      if (response.status !== 401) return { error: last };
    } catch {
      return { error: "the daemon is not reachable" };
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return { error: `${last} (the config reload did not land in time)` };
}

function formatCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export async function runDeviceCli(args: string[]): Promise<number> {
  const { positional, flags } = parseArgs(args);
  const command = positional[0];
  const { channel, port } = await readChannelConfig();

  if (!command || command === "help" || flags["help"] !== undefined) {
    console.log(USAGE);
    return command ? 0 : 1;
  }

  if (command === "ls") {
    const devices = listDevices(channel);
    if (devices.length === 0) {
      console.log("No paired device.");
      return 0;
    }
    for (const device of devices) {
      const state = device.enabled ? "" : " [disabled]";
      const seen = device.lastSeenAt ? ` last seen ${device.lastSeenAt}` : " never seen";
      console.log(`${device.deviceId}  ${device.kind}  owner=${device.owner}  "${device.name}"${state}${seen}`);
    }
    return 0;
  }

  if (command === "add") {
    const name = flags["name"]?.trim();
    if (!name) {
      console.error("a device needs --name");
      return 1;
    }
    const kind = flags["kind"] === "app" ? "app" : "web";
    const minted = await mintDevice(channel, { name, owner: flags["owner"], kind });
    if (!minted.ok) {
      console.error(minted.error);
      return 1;
    }

    console.log(`Device  ${minted.device.deviceId}  "${name}"  owner=${minted.device.owner}`);
    console.log(`Token   ${minted.device.token}`);

    const ticket = await requestTicket(port, minted.device.deviceId, minted.device.token);
    if ("error" in ticket) {
      console.log(`Claim   unavailable: ${ticket.error}`);
      console.log("        The device is written and live; pair with the token above.");
      return 0;
    }
    console.log(`Claim   http://${ticket.host}/pair#${ticket.code}`);
    console.log(`        or type ${formatCode(ticket.code)} in the pairing page`);
    return 0;
  }

  const deviceId = positional[1];
  if (!deviceId) {
    console.error(`${command} needs a device id`);
    return 1;
  }

  if (command === "rm") {
    const revoked = await revokeDevice(deviceId);
    if (!revoked.ok) {
      console.error(revoked.error);
      return 1;
    }
    console.log(`Revoked ${deviceId}`);
    return 0;
  }

  if (command === "disable" || command === "enable") {
    const toggled = await setDeviceEnabled(channel, deviceId, command === "enable");
    if (!toggled.ok) {
      console.error(toggled.error);
      return 1;
    }
    console.log(`${command === "enable" ? "Enabled" : "Disabled"} ${deviceId}`);
    return 0;
  }

  console.log(USAGE);
  return 1;
}
