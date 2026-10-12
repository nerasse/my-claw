import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { MY_CLAW_DIR } from "../core/config.ts";
import { writeFileAtomically } from "../utils/atomic-write.ts";
import type { PushNotification } from "./push.ts";

export const apnsRegistrationSchema = z.object({ registrationId: z.uuid(), secret: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();
export type APNsRegistration = z.infer<typeof apnsRegistrationSchema>;
let authorizedDevice: (deviceId: string) => boolean = () => false;
export function setAPNsDeviceAuthorization(verify: (deviceId: string) => boolean): void { authorizedDevice = verify; }
export function resetAPNsDeviceAuthorization(): void { authorizedDevice = () => false; }
export const APNS_PATH = join(MY_CLAW_DIR, "push", "apns.json");
export function relayURL(raw: string | undefined = process.env.MYCLAW_APNS_RELAY_URL): string | undefined {
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return undefined;
    return url.origin;
  } catch { return undefined; }
}
export class APNsRegistrationStore {
  private tail: Promise<void> = Promise.resolve();
  constructor(private readonly path: string) {}
  private async load(): Promise<Record<string, APNsRegistration>> {
    try { return z.record(z.string(), apnsRegistrationSchema).parse(JSON.parse(await readFile(this.path, "utf8"))); }
    catch (error) { if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return {}; throw new Error("APNs registration storage unavailable"); }
  }
  private change(update: (all: Record<string, APNsRegistration>) => void): Promise<void> {
    const task = this.tail.then(async () => { const all = await this.load(); update(all); await writeFileAtomically(this.path, JSON.stringify(all), { mode: 0o600 }); });
    this.tail = task.catch(() => {}); return task;
  }
  register(deviceId: string, registration: APNsRegistration): Promise<void> {
    const valid = apnsRegistrationSchema.parse(registration);
    return this.change(all => { all[deviceId] = valid; });
  }
  unregister(deviceId: string, expected?: string): Promise<void> {
    return this.change(all => { if (expected === undefined || all[deviceId]?.registrationId === expected) delete all[deviceId]; });
  }
  async entries(): Promise<Array<{ deviceId: string; registration: APNsRegistration }>> {
    await this.tail; return Object.entries(await this.load()).map(([deviceId, registration]) => ({ deviceId, registration }));
  }
  async clear(): Promise<void> { await this.tail; await rm(this.path, { force: true }); }
}
export const apnsStore = new APNsRegistrationStore(APNS_PATH);
interface RegistrationStatusDeps { store: APNsRegistrationStore; url?: string; authorized: (deviceId: string) => boolean }
/** Setup exposes only device IDs, and only while this instance can still use their registrations. */
export async function registeredAPNsDevices(
  deps: RegistrationStatusDeps = { store: apnsStore, url: relayURL(), authorized: deviceId => authorizedDevice(deviceId) },
): Promise<string[]> {
  if (!deps.url) return [];
  return (await deps.store.entries()).filter(entry => deps.authorized(entry.deviceId)).map(entry => entry.deviceId);
}
interface PublishDeps { store: APNsRegistrationStore; url?: string; wait: (ms: number) => Promise<void>; authorized?: (deviceId: string) => boolean }
export async function publishAPNs(notification: PushNotification, options?: { skipDevice?: (deviceId: string) => Promise<boolean> },
  deps: PublishDeps = { store: apnsStore, url: relayURL(), wait: ms => Bun.sleep(ms), authorized: deviceId => authorizedDevice(deviceId) }): Promise<number> {
  if (!deps.url || !notification.target) return 0;
  const targets = await deps.store.entries();
  const delivered = await Promise.all(targets.map(async ({ deviceId, registration }) => {
    if (deps.authorized && !deps.authorized(deviceId)) return 0;
    if (await options?.skipDevice?.(deviceId)) return 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (deps.authorized && !deps.authorized(deviceId)) return 0;
      const current = (await deps.store.entries()).find(entry => entry.deviceId === deviceId)?.registration;
      if (current?.registrationId !== registration.registrationId || current.secret !== registration.secret) return 0;
      if (deps.authorized && !deps.authorized(deviceId)) return 0;
      let response: Response;
      try {
        response = await fetch(`${deps.url}/v1/registrations/${registration.registrationId}/publish`, { method: "POST", redirect: "error",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${registration.secret}` },
          body: JSON.stringify({ title: notification.title.slice(0, 256), body: notification.body.slice(0, 600), target: notification.target, ring: notification.ring === true }),
          signal: AbortSignal.timeout(10_000) });
      } catch {
        if (attempt < 2) { await deps.wait(30_000); continue; } return 0;
      }
      await response.body?.cancel();
      if (response.status === 202) return 1;
      if (response.status === 410) { await deps.store.unregister(deviceId, registration.registrationId); return 0; }
      if (![429, 503].includes(response.status) || attempt === 2) return 0;
      const retry = Number(response.headers.get("retry-after") ?? "30");
      await deps.wait(Math.max(1, Math.min(60, Number.isFinite(retry) ? retry : 30)) * 1000);
    }
    return 0;
  }));
  return delivered.reduce<number>((total, count) => total + count, 0);
}
