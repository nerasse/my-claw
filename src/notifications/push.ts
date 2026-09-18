// Push notifications for the app channel, delivered over UnifiedPush with a self-hosted
// UnifiedPush server (ntfy) acting as the push server — no Firebase, no Google. Full design
// and setup in docs/notifications.md.
//
// The app registers with a UnifiedPush distributor on the device (the ntfy app) and receives
// a Web-Push-shaped subscription (endpoint + p256dh + auth). It sends the endpoint to us via
// the notifications.register frame; we then publish plaintext JSON to that endpoint whenever a
// run or a job completes. The distributor delivers it to the device even when the app is
// killed, and the app's native renderer (expo-unified-push) turns it into a system
// notification. Publishing to a UnifiedPush endpoint is a plain HTTP POST — the endpoint URL
// itself carries the secret, so no Web-Push/VAPID signing library is needed.
import { mkdir, readFile, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import webpush from "web-push";
import { MY_CLAW_DIR } from "../core/config.ts";
import { log } from "../utils/logger.ts";
import { writeFileAtomically } from "../utils/atomic-write.ts";

// VAPID requires a contact the push service can reach about a misbehaving sender. Nothing
// reads it here, but the spec (and some push servers) refuse a request without one.
const VAPID_SUBJECT = "mailto:my-claw@localhost";

const PUSH_DIR = join(MY_CLAW_DIR, "push");
const VAPID_PATH = join(PUSH_DIR, "vapid.json");
const ENDPOINTS_PATH = join(PUSH_DIR, "endpoints.json");
const FOREGROUND_PATH = join(PUSH_DIR, "foreground.json");

// The `id` the ntfy app's notification renderer reads first. A notification that names a target
// derives it from that target (see notificationIdFor); the counter only serves the ones that do
// not, where nothing can address them later.
let notificationCounter = Date.now();

/**
 * The notification id of a deep link, so a notification stays addressable after it is shown.
 *
 * Two things need that. The app dismisses a thread's notification when the owner opens that
 * thread from anywhere, and the only handle Android offers is the id the notification was posted
 * with; the app is usually killed when the push lands, so the id has to be derivable from the
 * link alone rather than remembered. And a second run on the same thread now replaces its own
 * notification instead of stacking a new one under it.
 *
 * FNV-1a folded into a positive 31-bit int: the renderer hands the number to Android as a signed
 * Int. The app computes the same hash (src/core/notifications.ts), so any change here is a wire
 * break and belongs in both repos at once.
 */
export function notificationIdFor(url: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < url.length; i++) {
    hash ^= url.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash & 0x7fffffff;
}

export interface PushEndpoint {
  endpoint: string;
  pubKey?: string;
  auth?: string;
  updatedAt: string;
}

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFileAtomically(path, JSON.stringify(value, null, 2));
}

/**
 * The VAPID keypair the distributor expects at registration (`registerDevice(vapid)`). The app
 * receives the public key in the notifications.info frame; the private key is kept here for
 * future use if publishing ever moves to Web-Push encryption. Both are generated once on first
 * boot and stable across restarts.
 */
export async function loadOrCreateVapid(): Promise<VapidKeys> {
  const existing = await readJson<VapidKeys>(VAPID_PATH);
  if (existing?.publicKey && existing.privateKey) return existing;

  // Application-server key in the web-push scheme: the public key is the raw P-256 point
  // (0x04 || X || Y, 65 bytes) and the private key is the raw 32-byte scalar, both base64url.
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const pub = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  const priv = privateKey.export({ type: "pkcs8", format: "der" }) as Buffer;

  const keys: VapidKeys = {
    publicKey: pub.subarray(pub.length - 65).toString("base64url"),
    privateKey: priv.subarray(priv.length - 32).toString("base64url"),
  };
  await writeJson(VAPID_PATH, keys);
  return keys;
}

export interface EndpointStore {
  register(deviceId: string, endpoint: PushEndpoint): Promise<void>;
  unregister(deviceId: string): Promise<void>;
  endpoints(): Promise<Array<{ deviceId: string; endpoint: PushEndpoint }>>;
}

function jsonEndpointStore(path: string): EndpointStore {
  async function load(): Promise<Record<string, PushEndpoint>> {
    return (await readJson<Record<string, PushEndpoint>>(path)) ?? {};
  }
  return {
    async register(deviceId, endpoint) {
      const all = await load();
      all[deviceId] = endpoint;
      await writeJson(path, all);
    },
    async unregister(deviceId) {
      const all = await load();
      if (!all[deviceId]) return;
      delete all[deviceId];
      await writeJson(path, all);
    },
    async endpoints() {
      const all = await load();
      return Object.entries(all).map(([deviceId, endpoint]) => ({ deviceId, endpoint }));
    },
  };
}

export const endpointStore = jsonEndpointStore(ENDPOINTS_PATH);

export interface ForegroundState {
  foreground: boolean;
  threadId?: string;
}

export interface DeviceForegroundStore {
  set(deviceId: string, state: ForegroundState): Promise<void>;
  get(deviceId: string): Promise<ForegroundState | undefined>;
}

export const foregroundStore: DeviceForegroundStore = {
  async set(deviceId, state) {
    const all = (await readJson<Record<string, ForegroundState>>(FOREGROUND_PATH)) ?? {};
    all[deviceId] = state;
    await writeJson(FOREGROUND_PATH, all);
  },
  async get(deviceId) {
    const all = (await readJson<Record<string, ForegroundState>>(FOREGROUND_PATH)) ?? {};
    return all[deviceId];
  },
};

export interface PushNotification {
  title: string;
  body: string;
  /** Deep link opened when the notification is tapped: myclaw://thread/<id> or myclaw://job/<id>. */
  url?: string;
  /**
   * Ask for the phone to ring rather than buzz: the payload names the `urgent` channel, which the
   * app pre-creates on the alarm stream, so it is heard in vibrate and in silent too. That is the
   * point of it -- an agent that has to be answered now -- so it is rate-limited instead: see
   * RING_COOLDOWN_MS.
   */
  ring?: boolean;
}

/**
 * Deliver a notification to every registered device. Best-effort: a dead endpoint (the app
 * changed distributor or the endpoint was revoked) fails here, not in the run path.
 * `skipDevice` filters per device before publishing — the run-completion notification skips a
 * device that is foreground on the very thread that just finished.
 */
/**
 * The Android channels the app pre-creates, and the only two names a payload may carry.
 *
 * `runs` is the ordinary one: IMPORTANCE_HIGH, the system's own notification sound, so it follows
 * the ringer mode like any other notification. `urgent` is the alarm stream, and it is what
 * "sonner" means -- it is heard with the phone on vibrate or silent. Channel settings are frozen
 * at first creation, so these names are a contract with the app: renaming one silently downgrades
 * every notification that carries it.
 */
const CHANNEL_ORDINARY = "runs";
const CHANNEL_URGENT = "urgent";

/**
 * A ring is a signal, not a weapon. An agent in a loop could otherwise ring the owner every
 * second, which trains him to silence the app -- the exact opposite of the point. Inside this
 * window a ring is downgraded to an ordinary notification rather than dropped: what the agent has
 * to say still arrives, it just stops shouting.
 */
const RING_COOLDOWN_MS = 10 * 60_000;
let lastRingAt = 0;

/** The plaintext notification: the renderer reads every field except the numeric id. */
export function buildPushPayload(notification: PushNotification): string {
  return JSON.stringify({
    id: notification.url ? notificationIdFor(notification.url) : notificationCounter++,
    type: notification.ring === true ? CHANNEL_URGENT : CHANNEL_ORDINARY,
    title: notification.title,
    body: notification.body,
    ...(notification.url ? { url: notification.url } : {}),
  });
}

export interface PublishOutcome {
  /** How many devices the push server accepted the notification for. */
  delivered: number;
  /** Whether it went out on the urgent channel; false when there was nothing to ring. */
  rang: boolean;
}

export async function publishNotification(
  notification: PushNotification,
  options?: { skipDevice?: (deviceId: string) => Promise<boolean> },
): Promise<PublishOutcome> {
  const targets = await endpointStore.endpoints();
  if (targets.length === 0) return { delivered: 0, rang: false };

  const vapid = await loadOrCreateVapid();
  const rang = notification.ring === true && Date.now() - lastRingAt >= RING_COOLDOWN_MS;
  if (rang) lastRingAt = Date.now();
  const payload = buildPushPayload({ ...notification, ring: rang });

  let delivered = 0;
  await Promise.all(targets.map(async ({ deviceId, endpoint }) => {
    if (options?.skipDevice && (await options.skipDevice(deviceId))) return;
    if (!endpoint.pubKey || !endpoint.auth) {
      void log("warn", "push endpoint has no encryption keys; skipping", { deviceId });
      return;
    }
    try {
      // The UnifiedPush connector decrypts with the keys it generated at registration and
      // drops anything it cannot decrypt, so the payload MUST be Web Push encrypted
      // (RFC 8291). web-push builds the encrypted body and the VAPID headers; the transport
      // stays plain fetch.
      const request = webpush.generateRequestDetails(
        { endpoint: endpoint.endpoint, keys: { p256dh: endpoint.pubKey, auth: endpoint.auth } },
        payload,
        {
          contentEncoding: "aes128gcm",
          vapidDetails: {
            subject: VAPID_SUBJECT,
            publicKey: vapid.publicKey,
            privateKey: vapid.privateKey,
          },
        },
      );
      const response = await fetch(request.endpoint, {
        method: "POST",
        headers: request.headers as Record<string, string>,
        body: request.body as Uint8Array,
      });
      if (response.ok) {
        delivered += 1;
        return;
      }
      // Web Push says these two are permanent: the subscription is gone, and every later
      // publish would fail the same way. Drop it instead of retrying forever.
      if (response.status === 404 || response.status === 410) {
        await endpointStore.unregister(deviceId);
        void log("info", "push endpoint gone; unregistered", { deviceId, status: response.status });
        return;
      }
      void log("warn", "push publish rejected by the push server", { deviceId, status: response.status, body: (await response.text()).slice(0, 200) });
    } catch (err) {
      void log("warn", "push publish failed", { deviceId, error: String(err) });
    }
  }));
  return { delivered, rang };
}

/** Whether a device is foreground on the given thread — the one case the run notification is skipped. */
export async function isForegroundOn(deviceId: string, threadId: string): Promise<boolean> {
  const state = await foregroundStore.get(deviceId);
  return Boolean(state?.foreground && state.threadId === threadId);
}

/**
 * A notification body is plain text: the run's response is markdown, and the system tray
 * renders none of it. Strip the markers, keep the bullet lines (a short list still reads as a
 * list), and let the caller truncate.
 */
export function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")          // fenced code blocks
    .replace(/`([^`]*)`/g, "$1")               // inline code
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")  // images -> alt text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")   // links -> their label
    .replace(/^#{1,6}\s+/gm, "")               // headings
    .replace(/^>\s?/gm, "")                    // blockquotes
    .replace(/\*\*([^*]+)\*\*/g, "$1")         // bold
    .replace(/\*([^*]+)\*/g, "$1")             // italic
    .replace(/~~([^~]+)~~/g, "$1")             // strikethrough
    .replace(/\n{3,}/g, "\n\n");
}

/** The em dash shows up in server error texts; a notification has no room for it. */
export function cleanNotificationText(text: string): string {
  return stripMarkdown(text).replace(/\s*—\s*/g, ": ").replace(/[ \t]+$/gm, "").trim();
}

/** Test seam: drops the stored endpoints and foreground state (setup-globals.ts). */
export async function resetPushState(): Promise<void> {
  lastRingAt = 0;
  for (const path of [ENDPOINTS_PATH, FOREGROUND_PATH]) {
    await rm(path, { force: true }).catch(() => {});
  }
  await mkdir(PUSH_DIR, { recursive: true });
}
