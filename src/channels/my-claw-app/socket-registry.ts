import type { ServerWebSocket } from "bun";
import type { MyClawAppSessionData } from "./controllers.ts";

type Socket = ServerWebSocket<MyClawAppSessionData>;

/**
 * The live sockets, grouped by device, several per device on purpose.
 *
 * It used to be one socket per device id, and a new one closed the old with `1000 "replaced"`. On
 * a browser the device id comes from the session cookie, which belongs to the profile and not to
 * the tab, so two tabs of one profile were one device: each open killed the other, each close
 * triggered a one second retry, and a successful open reset the backoff, so the war never decayed.
 * Measured on 2026-08-20: eleven connect/disconnect cycles in eleven seconds on a single device id.
 *
 * A device is therefore a group of surfaces, not a single one. Nothing downstream cares: every
 * broadcast already targets an owner, and the two frames that target a device (revoke, disable)
 * now hit all of its sockets instead of the last one to connect.
 */
export class SocketRegistry {
  private byDevice = new Map<string, Set<Socket>>();

  add(ws: Socket): void {
    const existing = this.byDevice.get(ws.data.deviceId);
    if (existing) existing.add(ws);
    else this.byDevice.set(ws.data.deviceId, new Set([ws]));
  }

  /** Drops exactly this socket. The device keeps its other surfaces. */
  remove(ws: Socket): boolean {
    const group = this.byDevice.get(ws.data.deviceId);
    if (!group?.delete(ws)) return false;
    if (group.size === 0) this.byDevice.delete(ws.data.deviceId);
    return true;
  }

  all(): Socket[] {
    return [...this.byDevice.values()].flatMap((group) => [...group]);
  }

  forDevice(deviceId: string): Socket[] {
    return [...(this.byDevice.get(deviceId) ?? [])];
  }

  forOwner(owner: string): Socket[] {
    return this.all().filter((ws) => ws.data.owner === owner);
  }

  deviceIds(): string[] {
    return [...this.byDevice.keys()];
  }

  has(ws: Socket): boolean {
    return this.byDevice.get(ws.data.deviceId)?.has(ws) === true;
  }

  get size(): number {
    return this.all().length;
  }

  /** How many surfaces this device has open. Zero when it is gone. */
  countFor(deviceId: string): number {
    return this.byDevice.get(deviceId)?.size ?? 0;
  }

  /**
   * Closes every socket of a device and forgets it. Used by revoke and by disable, both of which
   * are about the device as a whole: leaving one tab connected would defeat the point.
   */
  closeDevice(deviceId: string, code: number, reason: string): number {
    const group = this.forDevice(deviceId);
    for (const ws of group) {
      try {
        ws.close(code, reason);
      } catch {
        // already gone
      }
    }
    this.byDevice.delete(deviceId);
    return group.length;
  }

  clear(): void {
    this.byDevice.clear();
  }
}
