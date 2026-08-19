import type { ServerWebSocket } from "bun";
import type { MyClawAppChannelConfig } from "../../core/config.ts";
import { myClawAppLog } from "../../utils/logger.ts";
import type { MyClawAppSessionData } from "./controllers.ts";
import { listDevices, revokeDevice } from "./devices.ts";
import { approve, lookup } from "./pairing.ts";
import type { MyClawAppServerFrame } from "./types.ts";

/** What a device frame needs from the adapter: the roster it reads, the live sockets it closes,
 *  and the one exit every frame answers through. */
export interface MyClawAppDeviceDeps {
  readonly config: MyClawAppChannelConfig;
  readonly sockets: Map<string, ServerWebSocket<MyClawAppSessionData>>;
  sendFrame(ws: ServerWebSocket<MyClawAppSessionData> | undefined, frame: MyClawAppServerFrame): void;
}

/**
 * A device is only checked against the config when it connects, so disabling one (CLI, or a
 * hand edit of config.json) left the laptop already on the socket reading the conversation
 * until it happened to reconnect. Revoking closes the socket; disabling now does too.
 */
export function dropDisabledSockets(d: MyClawAppDeviceDeps): void {
  for (const [deviceId, ws] of d.sockets) {
    if (d.config.devices?.[deviceId]?.enabled !== false) continue;
    try {
      ws.close(1008, "disabled");
    } catch {
      // already gone
    }
    d.sockets.delete(deviceId);
    void myClawAppLog("info", "device socket closed: disabled", { deviceId });
  }
}

/** Conversation namespace of a device: its configured owner, else the device id itself. */
export function ownerFor(config: MyClawAppChannelConfig, deviceId: string): string {
  return config.devices?.[deviceId]?.owner?.trim() || deviceId;
}

/**
 * Revoking a device closes its sockets and drops its browser sessions in the same breath:
 * waiting for the next connect would leave a revoked laptop reading the conversation.
 */
export async function handleDeviceRevoke(d: MyClawAppDeviceDeps, ws: ServerWebSocket<MyClawAppSessionData>, deviceId: string): Promise<void> {
  if (typeof deviceId !== "string" || ownerFor(d.config, deviceId) !== ws.data.owner) {
    d.sendFrame(ws, {
      type: "device.revoke.result",
      ok: false,
      deviceId,
      error: "unknown device",
    });
    return;
  }
  if (deviceId === ws.data.deviceId) {
    d.sendFrame(ws, {
      type: "device.revoke.result",
      ok: false,
      deviceId,
      error: "a device cannot revoke itself",
    });
    return;
  }
  // The browser sessions go with the device inside revokeDevice, for every caller: the socket
  // is what only this path can close.
  const revoked = await revokeDevice(deviceId, d.config);
  if (revoked.ok) {
    const live = d.sockets.get(deviceId);
    if (live) {
      try {
        live.close(1008, "revoked");
      } catch {
        // already gone
      }
      d.sockets.delete(deviceId);
    }
  }
  d.sendFrame(ws, {
    type: "device.revoke.result",
    ok: revoked.ok,
    deviceId,
    ...(revoked.error ? { error: revoked.error } : {}),
  });
  if (revoked.ok) mirrorDeviceList(d, ws);
}

/**
 * The roster after a change, to the owner's *other* windows. Rebuilt per socket instead of
 * mirrored as one frame, because `self` is a statement about the socket it goes to: a device
 * revoked or paired from the phone has to leave (or join) the laptop's list without a reload.
 */
function mirrorDeviceList(d: MyClawAppDeviceDeps, sender: ServerWebSocket<MyClawAppSessionData>): void {
  for (const other of d.sockets.values()) {
    if (other !== sender && other.data.owner === sender.data.owner) handleDeviceList(d, other);
  }
}

export function handlePairLookup(d: MyClawAppDeviceDeps, ws: ServerWebSocket<MyClawAppSessionData>, code: string): void {
  const found = lookup(code, ws.data.deviceId);
  if (!found.ok) {
    d.sendFrame(ws, { type: "device.pair.result", ok: false, error: found.reason });
    return;
  }
  // Everything the owner needs to recognise the browser in front of them, and no credential.
  d.sendFrame(ws, {
    type: "device.pair.info",
    code: found.session.code,
    verification: found.session.verification,
    expiresAt: found.session.expiresAt,
    ...(found.session.origin ? { origin: found.session.origin } : {}),
    ...(found.session.ip ? { ip: found.session.ip } : {}),
    ...(found.session.userAgent ? { userAgent: found.session.userAgent } : {}),
  });
}

export async function handlePairApprove(
  d: MyClawAppDeviceDeps,
  ws: ServerWebSocket<MyClawAppSessionData>,
  code: string,
  name: string,
): Promise<void> {
  // The new device joins the approver's owner: a browser paired from a phone lands on the
  // same threads, which is the whole point of the shared namespace.
  const approved = await approve(d.config, code, {
    name: name.trim() || "browser",
    owner: ws.data.owner,
    approver: ws.data.deviceId,
  });
  d.sendFrame(ws, {
    type: "device.pair.result",
    ok: approved.ok,
    ...(approved.ok ? { deviceId: approved.deviceId } : { error: approved.error }),
  });
  if (approved.ok) mirrorDeviceList(d, ws);
}

export function handleDeviceList(d: MyClawAppDeviceDeps, ws: ServerWebSocket<MyClawAppSessionData>): void {
  d.sendFrame(ws, {
    type: "device.list.result",
    // Scoped like every other frame on this socket: the device roster of another owner is
    // not this owner's business, and the list is what a revoke is aimed from.
    devices: listDevices(d.config)
      .filter((device) => ownerFor(d.config, device.deviceId) === ws.data.owner)
      .map((device) => ({
        ...device,
        self: device.deviceId === ws.data.deviceId,
      })),
  });
}

