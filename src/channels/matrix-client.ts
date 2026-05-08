import {
  ClientEvent,
  EventType,
  RoomEvent,
  SyncState,
  createClient,
  type MatrixClient,
  type MatrixEvent,
  type Room,
} from "matrix-js-sdk";
import { logger as matrixSdkRootLogger } from "matrix-js-sdk/lib/logger.js";
import { Attachment, EncryptedAttachment, initAsync as initMatrixCryptoAsync } from "@matrix-org/matrix-sdk-crypto-wasm";
import {
  IDBCursor,
  IDBCursorWithValue,
  IDBDatabase,
  IDBFactory,
  IDBIndex,
  IDBKeyRange,
  IDBObjectStore,
  IDBOpenDBRequest,
  IDBRequest,
  IDBTransaction,
  IDBVersionChangeEvent,
  indexedDB as fakeIndexedDB,
} from "fake-indexeddb";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createSdkLogger, installMatrixSdkRootLogger, matrixLog } from "../utils/logger.ts";
import { copyIdbSnapshotWithPrefix, persistIdbToDisk, restoreIdbFromDisk } from "./matrix-crypto-idb.ts";
import { MatrixDecryptBridge, type MatrixDecryptionFailure } from "./matrix/decrypt-bridge.ts";
import { FileBackedMatrixSyncStore } from "./matrix/file-sync-store.ts";
import {
  resolveMatrixRuntimeStoragePaths,
  resolveOpenClawSnapshotPath,
  type MatrixRuntimeStoragePaths,
} from "./matrix/storage.ts";

export interface MatrixRuntimeConfig {
  homeserver: string;
  accessToken: string;
  encryption?: boolean;
  userId?: string;
  password?: string;
  deviceId?: string;
  initialSyncLimit?: number;
}

export interface MatrixTimelineEvent {
  room: Room;
  event: MatrixEvent;
  toStartOfTimeline: boolean;
  removed: boolean;
  liveEvent: boolean;
}

type MatrixRuntimeCryptoFacade = {
  decryptMedia: (
    file: {
      url: string;
      key?: Record<string, unknown>;
      iv?: string;
      hashes?: Record<string, string>;
      v?: string;
    },
    opts?: { maxBytes?: number; readIdleTimeoutMs?: number },
  ) => Promise<Buffer>;
  encryptMedia: (
    buffer: Buffer,
  ) => Promise<{
    buffer: Buffer;
    file: {
      key?: Record<string, unknown>;
      iv?: string;
      hashes?: Record<string, string>;
      v?: string;
    };
  }>;
  isRoomEncrypted: (roomId: string) => Promise<boolean>;
};

const MATRIX_IDB_PERSIST_INTERVAL_MS = 60_000;
const MATRIX_DECRYPT_FAILURE_WINDOW_MS = 2 * 60_000;
const MATRIX_DECRYPT_FAILURE_THRESHOLD = 3;

function ensureIndexedDbRuntime(): void {
  const scope = globalThis as typeof globalThis & {
    indexedDB?: unknown;
    IDBCursor?: unknown;
    IDBCursorWithValue?: unknown;
    IDBDatabase?: unknown;
    IDBFactory?: unknown;
    IDBIndex?: unknown;
    IDBKeyRange?: unknown;
    IDBObjectStore?: unknown;
    IDBOpenDBRequest?: unknown;
    IDBRequest?: unknown;
    IDBTransaction?: unknown;
    IDBVersionChangeEvent?: unknown;
  };
  if (scope.indexedDB) {
    return;
  }
  scope.indexedDB = fakeIndexedDB;
  scope.IDBCursor = IDBCursor;
  scope.IDBCursorWithValue = IDBCursorWithValue;
  scope.IDBDatabase = IDBDatabase;
  scope.IDBFactory = IDBFactory;
  scope.IDBIndex = IDBIndex;
  scope.IDBKeyRange = IDBKeyRange;
  scope.IDBObjectStore = IDBObjectStore;
  scope.IDBOpenDBRequest = IDBOpenDBRequest;
  scope.IDBRequest = IDBRequest;
  scope.IDBTransaction = IDBTransaction;
  scope.IDBVersionChangeEvent = IDBVersionChangeEvent;
}

export class MatrixClientRuntime {
  private client: MatrixClient;
  private readyPromise: Promise<void> | null = null;
  private timelineHandlers = new Set<(event: MatrixTimelineEvent) => void | Promise<void>>();
  private started = false;
  private crypto?: MatrixRuntimeCryptoFacade;
  private cryptoPersistTimer: ReturnType<typeof setInterval> | null = null;
  private readonly decryptBridge: MatrixDecryptBridge;
  private readonly storagePaths: MatrixRuntimeStoragePaths;
  private readonly syncStore: FileBackedMatrixSyncStore;
  private readonly decryptFailureCounts = new Map<string, number[]>();

  constructor(
    private config: MatrixRuntimeConfig,
    client?: MatrixClient,
  ) {
    installMatrixSdkRootLogger(matrixSdkRootLogger);
    this.storagePaths = resolveMatrixRuntimeStoragePaths(config);
    this.syncStore = new FileBackedMatrixSyncStore(this.storagePaths.syncPath);
    this.client =
      client ??
      createClient({
        baseUrl: config.homeserver,
        accessToken: config.accessToken,
        userId: config.userId,
        deviceId: config.deviceId,
        store: this.syncStore,
        logger: createSdkLogger("matrix-sdk"),
      });
    this.decryptBridge = new MatrixDecryptBridge({
      client: this.client,
      emitDecryptedEvent: (roomId, event) => {
        const room = this.client.getRoom(roomId);
        if (!room) {
          return;
        }
        this.emitTimelineHandlers({
          room,
          event,
          toStartOfTimeline: false,
          removed: false,
          liveEvent: true,
        });
      },
      emitFailedDecryption: (failure) => {
        void this.handleFailedDecryption(failure);
      },
    });
  }

  get sdk(): MatrixClient {
    return this.client;
  }

  get mediaCrypto(): MatrixRuntimeCryptoFacade | undefined {
    return this.crypto;
  }

  encryptionReady(): boolean {
    return this.crypto !== undefined;
  }

  getStoragePaths(): MatrixRuntimeStoragePaths {
    return this.storagePaths;
  }

  hasPersistedSyncState(): boolean {
    return this.syncStore.hasSavedSyncFromCleanShutdown();
  }

  onTimeline(handler: (event: MatrixTimelineEvent) => void | Promise<void>): () => void {
    this.timelineHandlers.add(handler);
    return () => {
      this.timelineHandlers.delete(handler);
    };
  }

  async start(): Promise<void> {
    if (this.started) {
      if (this.readyPromise) await this.readyPromise;
      return;
    }

    this.started = true;
    await mkdir(this.storagePaths.rootDir, { recursive: true });
    await this.initializeCrypto();
    this.client.on(RoomEvent.Timeline, this.handleTimeline);
    this.readyPromise = new Promise<void>((resolve, reject) => {
      const onSync = (state: SyncState, _prev: SyncState | null, data?: { error?: Error }) => {
        if (state === SyncState.Prepared || state === SyncState.Syncing) {
          this.client.off(ClientEvent.Sync, onSync);
          resolve();
        }
        if (state === SyncState.Error && data?.error) {
          this.client.off(ClientEvent.Sync, onSync);
          reject(data.error);
        }
      };
      this.client.on(ClientEvent.Sync, onSync);
    });

    await this.client.startClient({ initialSyncLimit: this.config.initialSyncLimit ?? 20 });
    await this.readyPromise;
  }

  async stop(): Promise<void> {
    this.client.off(RoomEvent.Timeline, this.handleTimeline);
    if (this.cryptoPersistTimer) {
      clearInterval(this.cryptoPersistTimer);
      this.cryptoPersistTimer = null;
    }
    await this.decryptBridge.drainPendingDecryptions("matrix client shutdown").catch(() => undefined);
    this.decryptBridge.stop();
    this.client.stopClient();
    this.started = false;
    this.readyPromise = null;
    await this.persistCryptoSnapshot().catch(() => undefined);
    this.syncStore.markCleanShutdown();
    await this.syncStore.flush().catch(() => undefined);
  }

  private async initializeCrypto(): Promise<void> {
    if (this.config.encryption !== true) {
      return;
    }
    const userId = this.config.userId?.trim();
    const deviceId = this.config.deviceId?.trim();
    if (!userId || !deviceId) {
      await matrixLog("warn", "matrix encryption skipped: missing userId or deviceId");
      return;
    }

    try {
      ensureIndexedDbRuntime();
      await initMatrixCryptoAsync();
      const openClaw = resolveOpenClawSnapshotPath(this.config);
      if (!existsSync(this.storagePaths.cryptoSnapshotPath) && existsSync(openClaw.snapshotPath)) {
        await copyIdbSnapshotWithPrefix({
          sourcePath: openClaw.snapshotPath,
          targetPath: this.storagePaths.cryptoSnapshotPath,
          fromPrefix: openClaw.prefix,
          toPrefix: this.storagePaths.cryptoDatabasePrefix,
        }).catch(() => undefined);
      }
      await restoreIdbFromDisk(this.storagePaths.cryptoSnapshotPath).catch(() => false);
      await this.client.initRustCrypto({
        cryptoDatabasePrefix: this.storagePaths.cryptoDatabasePrefix,
      });
      this.crypto = {
        decryptMedia: async (file, opts) => {
          const contentUrl = this.client.mxcUrlToHttp(
            file.url,
            undefined,
            undefined,
            undefined,
            true,
            false,
            true,
          ) ?? this.client.mxcUrlToHttp(file.url, undefined, undefined, undefined, true) ?? file.url;
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), opts?.readIdleTimeoutMs ?? 30_000);
          try {
            const response = await fetch(contentUrl, {
              headers: { Accept: "*/*" },
              signal: controller.signal,
            });
            if (!response.ok) {
              throw new Error(`Matrix encrypted media download failed: HTTP ${response.status}`);
            }
            const encrypted = Buffer.from(await response.arrayBuffer());
            if (typeof opts?.maxBytes === "number" && encrypted.byteLength > opts.maxBytes) {
              throw new Error("Matrix encrypted media exceeds size limit");
            }
            const attachment = new EncryptedAttachment(
              new Uint8Array(encrypted),
              JSON.stringify({
                url: file.url,
                key: file.key,
                iv: file.iv,
                hashes: file.hashes,
                v: file.v,
              }),
            );
            return Buffer.from(Attachment.decrypt(attachment));
          } finally {
            clearTimeout(timeout);
          }
        },
        encryptMedia: async (buffer) => {
          const encrypted = Attachment.encrypt(new Uint8Array(buffer));
          const mediaEncryptionInfo = encrypted.mediaEncryptionInfo;
          if (!mediaEncryptionInfo) {
            throw new Error("Matrix media encryption failed: missing media encryption info");
          }
          const parsed = JSON.parse(mediaEncryptionInfo) as {
            key?: Record<string, unknown>;
            iv?: string;
            hashes?: Record<string, string>;
            v?: string;
          };
          return {
            buffer: Buffer.from(encrypted.encryptedData),
            file: {
              key: parsed.key,
              iv: parsed.iv,
              hashes: parsed.hashes,
              v: parsed.v,
            },
          };
        },
        isRoomEncrypted: async (roomId) => {
          const room = this.client.getRoom(roomId);
          if (room?.hasEncryptionStateEvent()) {
            return true;
          }
          const cryptoApi = this.client.getCrypto();
          return (await cryptoApi?.isEncryptionEnabledInRoom(roomId)) === true;
        },
      };
      await this.persistCryptoSnapshot().catch(() => undefined);
      this.cryptoPersistTimer = setInterval(() => {
        void this.persistCryptoSnapshot().catch(() => undefined);
      }, MATRIX_IDB_PERSIST_INTERVAL_MS);
      this.decryptBridge.bindCryptoRetrySignals(
        this.client.getCrypto() as { on: (eventName: string, listener: (...args: unknown[]) => void) => void } | undefined,
      );
    } catch (error) {
      await matrixLog("warn", "matrix rust crypto init failed", { error: String(error) });
    }
  }

  private async persistCryptoSnapshot(): Promise<void> {
    if (!this.crypto) {
      return;
    }
    await persistIdbToDisk(
      this.storagePaths.cryptoSnapshotPath,
      this.storagePaths.cryptoDatabasePrefix,
    );
  }

  private handleTimeline = (
    event: MatrixEvent,
    room: Room | undefined,
    toStartOfTimeline: boolean | undefined,
    removed: boolean,
    data?: { liveEvent?: boolean },
  ): void => {
    if (!room) return;
    const liveEvent = data?.liveEvent === true;
    if (event.getType() === EventType.RoomMessageEncrypted) {
      if (liveEvent) {
        this.decryptBridge.attachEncryptedEvent(event, room.roomId);
      }
      return;
    }
    const eventId = event.getId() ?? "";
    if (!this.decryptBridge.shouldEmitUnencryptedMessage(room.roomId, eventId)) {
      return;
    }
    this.emitTimelineHandlers({
      room,
      event,
      toStartOfTimeline: toStartOfTimeline === true,
      removed,
      liveEvent,
    });
  };

  private emitTimelineHandlers(payload: MatrixTimelineEvent): void {
    void Promise.allSettled(
      [...this.timelineHandlers].map((handler) => Promise.resolve(handler(payload))),
    );
  }

  private async handleFailedDecryption(failure: MatrixDecryptionFailure): Promise<void> {
    await matrixLog("warn", "matrix event decryption failed", {
      roomId: failure.roomId,
      eventId: failure.eventId,
      sender: failure.sender,
      retryable: failure.isRetryable,
      error: String(failure.error),
    });

    if (failure.sender && failure.sender === (this.client.getUserId() ?? this.config.userId)) {
      await matrixLog("warn", "matrix event decryption failed for own Matrix user", {
        roomId: failure.roomId,
        eventId: failure.eventId,
        sender: failure.sender,
      });
    }

    const now = Date.now();
    const existing = this.decryptFailureCounts.get(failure.roomId) ?? [];
    const recent = existing.filter((timestamp) => now - timestamp <= MATRIX_DECRYPT_FAILURE_WINDOW_MS);
    recent.push(now);
    this.decryptFailureCounts.set(failure.roomId, recent);
    if (recent.length === MATRIX_DECRYPT_FAILURE_THRESHOLD) {
      await matrixLog("warn", "matrix decryption failures are repeating in this room", {
        roomId: failure.roomId,
        eventId: failure.eventId,
        failuresInWindow: recent.length,
        windowMs: MATRIX_DECRYPT_FAILURE_WINDOW_MS,
      });
    }
  }
}
