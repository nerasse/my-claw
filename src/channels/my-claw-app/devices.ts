import { apnsStore } from "../../notifications/apns.ts";
import { randomBytes } from "node:crypto";
import type { MyClawAppChannelConfig } from "../../core/config.ts";
import { upsertDevice, removeDevice, type DeviceEntry } from "../../core/config-edit.ts";
import { revokeSessionsOfDevice } from "./web-session.ts";
import { myClawAppLog } from "../../utils/logger.ts";

/**
 * The device lifecycle, and the only writer of `channels.my-claw-app.devices`.
 *
 * Two paths mint a device (the CLI and the pairing flow, docs/web-pairing.md) and they share
 * this module so an id, a token and an owner are decided in exactly one place. Everything goes
 * through config-edit, which snapshots before writing: a minted credential is diffable and
 * revocable like any other config change.
 */

export interface DeviceRecord {
  deviceId: string;
  name: string;
  kind: "app" | "web";
  owner: string;
  enabled: boolean;
  createdAt?: string;
  lastSeenAt?: string;
}

export interface MintOptions {
  name: string;
  owner?: string;
  kind?: "app" | "web";
}

export interface MintResult {
  deviceId: string;
  token: string;
  owner: string;
}

/** Readable enough for a config file and a log line, random enough not to be guessed at. */
function newDeviceId(kind: "app" | "web"): string {
  return `${kind}-${randomBytes(4).toString("hex")}`;
}

function newToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * The channel config is passed in, never read from a global: the adapter owns its snapshot and
 * hot-reloads it, and a second source of truth here would answer with a stale device list.
 */
function devicesOf(config: MyClawAppChannelConfig): Record<string, DeviceEntry> {
  return (config.devices ?? {}) as Record<string, DeviceEntry>;
}

/** The owner a device without an explicit one falls back to: its own id (docs/my-claw-app-channel.md). */
export function ownerOf(config: MyClawAppChannelConfig, deviceId: string): string {
  return devicesOf(config)[deviceId]?.owner ?? deviceId;
}

/**
 * The owner a new device joins when the caller did not name one.
 *
 * One existing owner means there is nothing to choose. Several means the answer is a guess, and
 * a guess here puts a browser on somebody else's conversations, so it refuses instead.
 */
export function defaultOwner(
  config: MyClawAppChannelConfig,
): { ok: true; owner: string } | { ok: false; owners: string[] } {
  const owners = [...new Set(Object.keys(devicesOf(config)).map((id) => ownerOf(config, id)))];
  if (owners.length === 1) return { ok: true, owner: owners[0]! };
  if (owners.length === 0) return { ok: true, owner: "owner" };
  return { ok: false, owners };
}

export function listDevices(config: MyClawAppChannelConfig): DeviceRecord[] {
  return Object.entries(devicesOf(config))
    .map(([deviceId, entry]) => ({
      deviceId,
      name: entry.name ?? deviceId,
      kind: entry.kind ?? "app",
      owner: entry.owner ?? deviceId,
      enabled: entry.enabled !== false,
      createdAt: entry.createdAt,
      lastSeenAt: entry.lastSeenAt,
    }))
    .sort((a, b) => a.deviceId.localeCompare(b.deviceId));
}

export function findDevice(config: MyClawAppChannelConfig, deviceId: string): DeviceRecord | undefined {
  return listDevices(config).find((device) => device.deviceId === deviceId);
}

export async function mintDevice(
  config: MyClawAppChannelConfig,
  options: MintOptions,
): Promise<{ ok: true; device: MintResult } | { ok: false; error: string }> {
  const kind = options.kind ?? "web";
  const name = options.name.trim();
  if (!name) return { ok: false, error: "a device needs a name" };

  let owner = options.owner?.trim();
  if (!owner) {
    const resolved = defaultOwner(config);
    if (!resolved.ok) {
      return { ok: false, error: `several owners exist (${resolved.owners.join(", ")}), name one` };
    }
    owner = resolved.owner;
  }

  const deviceId = newDeviceId(kind);
  const token = newToken();
  const entry: DeviceEntry = {
    token,
    name,
    kind,
    owner,
    enabled: true,
    createdAt: new Date().toISOString(),
  };
  const written = await upsertDevice(deviceId, entry);
  if (!written.ok) return { ok: false, error: written.error };
  applyLive(config, deviceId, entry);

  myClawAppLog("info", "device minted", { deviceId, kind, owner, name });
  return { ok: true, device: { deviceId, token, owner } };
}

/**
 * Removing a device takes its browser sessions with it, whoever asks.
 *
 * The adapter did this itself, so the app's Devices screen was clean and `myclaw device rm` was
 * not: it left the session row behind, and a store of credentials pointing at devices that no
 * longer exist is exactly the sort of thing that stays harmless until it is not. It belongs here,
 * on the one function that removes a device.
 */
export async function revokeDevice(
  deviceId: string,
  config?: MyClawAppChannelConfig,
): Promise<{ ok: boolean; error?: string }> {
  const written = await removeDevice(deviceId);
  if (!written.ok) return { ok: false, error: written.error };
  if (config?.devices) delete config.devices[deviceId];
  const sessions = await revokeSessionsOfDevice(deviceId);
  await cleanAPNsRegistration(deviceId);
  myClawAppLog("info", "device revoked", { deviceId, sessions });
  return { ok: true };
}

export async function setDeviceEnabled(
  config: MyClawAppChannelConfig,
  deviceId: string,
  enabled: boolean,
): Promise<{ ok: boolean; error?: string }> {
  const entry = devicesOf(config)[deviceId];
  if (!entry) return { ok: false, error: `unknown device ${deviceId}` };
  const written = await upsertDevice(deviceId, { token: entry.token, enabled });
  if (!written.ok) return { ok: false, error: written.error };
  applyLive(config, deviceId, { ...entry, enabled });
  if (!enabled) await cleanAPNsRegistration(deviceId);
  myClawAppLog("info", "device toggled", { deviceId, enabled });
  return { ok: true };
}

/**
 * Mirrors the write into the live config object the adapter holds.
 *
 * The file watcher is not a reliable way to observe your own write: the event can be collapsed
 * into the debounce of an earlier one, and a device minted at runtime then stays invisible until
 * something else touches the file. Measured, not theorised: a browser paired successfully and
 * was refused on its very next request. The later reload re-applies the same values and is a
 * no-op, so this only ever removes a window, never a source of truth.
 */
function applyLive(config: MyClawAppChannelConfig, deviceId: string, entry: DeviceEntry): void {
  const devices = (config.devices ?? {}) as Record<string, DeviceEntry>;
  devices[deviceId] = { ...devices[deviceId], ...entry };
  config.devices = devices;
}

const SEEN_INTERVAL_MS = 60_000;
const lastWrittenSeen = new Map<string, number>();

/**
 * Records that a device is alive, at most once a minute.
 *
 * Without the throttle a connected app rewrites config.json on every frame, which would churn
 * the snapshot history and race the file watcher against itself.
 */
export async function touchDevice(config: MyClawAppChannelConfig, deviceId: string): Promise<void> {
  const now = Date.now();
  const previous = lastWrittenSeen.get(deviceId) ?? 0;
  if (now - previous < SEEN_INTERVAL_MS) return;
  lastWrittenSeen.set(deviceId, now);

  const entry = devicesOf(config)[deviceId];
  if (!entry) return;
  const lastSeenAt = new Date(now).toISOString();
  const written = await upsertDevice(deviceId, { token: entry.token, lastSeenAt });
  if (!written.ok) {
    myClawAppLog("warn", "lastSeen write failed", { deviceId, error: written.error });
    return;
  }
  applyLive(config, deviceId, { ...entry, lastSeenAt });
}

/** Module-level throttle state, reset between test files. */
export function resetDeviceSeenCache(): void {
  lastWrittenSeen.clear();
}

async function cleanAPNsRegistration(deviceId: string): Promise<void> {
  try { await apnsStore.unregister(deviceId); }
  catch { void myClawAppLog("warn", "APNs registration cleanup unavailable", { deviceId }); }
}
