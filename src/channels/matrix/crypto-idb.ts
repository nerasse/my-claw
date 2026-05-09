import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

type IdbKeyPath = string | string[] | null;

type IdbStoreSnapshot = {
  name: string;
  keyPath: IdbKeyPath;
  autoIncrement: boolean;
  indexes: { name: string; keyPath: string | string[]; multiEntry: boolean; unique: boolean }[];
  records: { key: unknown; value: unknown }[];
};

type IdbDatabaseSnapshot = {
  name: string;
  version: number;
  stores: IdbStoreSnapshot[];
};

type IdbRequestLike<T> = {
  result: T;
  error: unknown;
  addEventListener: (event: string, listener: () => void, opts?: { once?: boolean }) => void;
};

type IdbIndexLike = {
  keyPath: string | string[];
  multiEntry: boolean;
  unique: boolean;
};

type IdbObjectStoreLike = {
  keyPath: IdbKeyPath;
  autoIncrement: boolean;
  indexNames: Iterable<string>;
  index: (name: string) => IdbIndexLike;
  getAllKeys: () => IdbRequestLike<unknown[]>;
  getAll: () => IdbRequestLike<unknown[]>;
  put: (value: unknown, key?: unknown) => void;
  createIndex: (
    name: string,
    keyPath: string | string[],
    options: { unique: boolean; multiEntry: boolean },
  ) => void;
};

type IdbTransactionLike = {
  error: unknown;
  objectStore: (name: string) => IdbObjectStoreLike;
  addEventListener: (event: string, listener: () => void, opts?: { once?: boolean }) => void;
};

type IdbDatabaseLike = {
  name: string;
  version: number;
  objectStoreNames: Iterable<string>;
  transaction: (storeName: string, mode: string) => IdbTransactionLike;
  createObjectStore: (name: string, options: { keyPath?: IdbKeyPath; autoIncrement?: boolean }) => IdbObjectStoreLike;
  close: () => void;
};

type IdbFactoryLike = {
  databases: () => Promise<Array<{ name?: string; version?: number }>>;
  open: (name: string, version?: number) => IdbRequestLike<IdbDatabaseLike>;
};

function resolveIndexedDb(): IdbFactoryLike {
  const value = (globalThis as { indexedDB?: unknown }).indexedDB;
  if (!value || typeof value !== "object") {
    throw new Error("IndexedDB is unavailable");
  }
  return value as IdbFactoryLike;
}

function req<T>(request: IdbRequestLike<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error), { once: true });
  });
}

function parseSnapshotPayload(data: string): IdbDatabaseSnapshot[] | null {
  const parsed = JSON.parse(data) as unknown;
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return null;
  }
  return parsed as IdbDatabaseSnapshot[];
}

async function dumpIndexedDatabases(databasePrefix?: string): Promise<IdbDatabaseSnapshot[]> {
  const indexedDb = resolveIndexedDb();
  const databases = await indexedDb.databases();
  const expectedPrefix = databasePrefix ? `${databasePrefix}::` : null;
  const snapshot: IdbDatabaseSnapshot[] = [];

  for (const database of databases) {
    if (!database.name || !database.version) {
      continue;
    }
    if (expectedPrefix && !database.name.startsWith(expectedPrefix)) {
      continue;
    }
    const db = await new Promise<IdbDatabaseLike>((resolve, reject) => {
      const request = indexedDb.open(database.name!, database.version!);
      request.addEventListener("success", () => resolve(request.result), { once: true });
      request.addEventListener("error", () => reject(request.error), { once: true });
    });
    const stores: IdbStoreSnapshot[] = [];
    for (const storeNameValue of db.objectStoreNames) {
      const storeName = String(storeNameValue);
      const tx = db.transaction(storeName, "readonly");
      const store = tx.objectStore(storeName);
      const keys = await req(store.getAllKeys());
      const values = await req(store.getAll());
      stores.push({
        name: storeName,
        keyPath: store.keyPath,
        autoIncrement: store.autoIncrement,
        indexes: Array.from(store.indexNames, (indexNameValue) => {
          const indexName = String(indexNameValue);
          const index = store.index(indexName);
          return {
            name: indexName,
            keyPath: index.keyPath,
            multiEntry: index.multiEntry,
            unique: index.unique,
          };
        }),
        records: keys.map((key, index) => ({ key, value: values[index] })),
      });
    }
    snapshot.push({ name: db.name, version: db.version, stores });
    db.close();
  }

  return snapshot;
}

async function restoreIndexedDatabases(snapshot: IdbDatabaseSnapshot[]): Promise<void> {
  const indexedDb = resolveIndexedDb();
  for (const dbSnapshot of snapshot) {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDb.open(dbSnapshot.name, dbSnapshot.version);
      request.addEventListener("upgradeneeded", () => {
        const db = request.result;
        for (const storeSnapshot of dbSnapshot.stores) {
          const options: { keyPath?: IdbKeyPath; autoIncrement?: boolean } = {};
          if (storeSnapshot.keyPath !== null) {
            options.keyPath = storeSnapshot.keyPath;
          }
          if (storeSnapshot.autoIncrement) {
            options.autoIncrement = true;
          }
          const store = db.createObjectStore(storeSnapshot.name, options);
          for (const index of storeSnapshot.indexes) {
            store.createIndex(index.name, index.keyPath, {
              unique: index.unique,
              multiEntry: index.multiEntry,
            });
          }
        }
      }, { once: true });
      request.addEventListener("success", () => {
        void (async () => {
          const db = request.result;
          for (const storeSnapshot of dbSnapshot.stores) {
            if (storeSnapshot.records.length === 0) {
              continue;
            }
            const tx = db.transaction(storeSnapshot.name, "readwrite");
            const store = tx.objectStore(storeSnapshot.name);
            for (const record of storeSnapshot.records) {
              if (storeSnapshot.keyPath !== null) {
                store.put(record.value);
              } else {
                store.put(record.value, record.key);
              }
            }
            await new Promise<void>((resolveTx, rejectTx) => {
              tx.addEventListener("complete", () => resolveTx(), { once: true });
              tx.addEventListener("error", () => rejectTx(tx.error), { once: true });
              tx.addEventListener("abort", () => rejectTx(tx.error), { once: true });
            });
          }
          db.close();
          resolve();
        })().catch(reject);
      }, { once: true });
      request.addEventListener("error", () => reject(request.error), { once: true });
    });
  }
}

export async function restoreIdbFromDisk(snapshotPath: string): Promise<boolean> {
  if (!existsSync(snapshotPath)) {
    return false;
  }
  const snapshot = parseSnapshotPayload(readFileSync(snapshotPath, "utf8"));
  if (!snapshot) {
    return false;
  }
  await restoreIndexedDatabases(snapshot);
  return true;
}

export async function persistIdbToDisk(snapshotPath: string, databasePrefix?: string): Promise<void> {
  const snapshot = await dumpIndexedDatabases(databasePrefix);
  if (snapshot.length === 0) {
    return;
  }
  await mkdir(dirname(snapshotPath), { recursive: true });
  await writeFile(snapshotPath, JSON.stringify(snapshot), { mode: 0o600 });
}

export async function copyIdbSnapshotWithPrefix(params: {
  sourcePath: string;
  targetPath: string;
  fromPrefix: string;
  toPrefix: string;
}): Promise<boolean> {
  if (!existsSync(params.sourcePath)) {
    return false;
  }
  const snapshot = parseSnapshotPayload(readFileSync(params.sourcePath, "utf8"));
  if (!snapshot) {
    return false;
  }
  const rewritten = snapshot.map((database) => ({
    ...database,
    name: database.name.startsWith(`${params.fromPrefix}::`)
      ? `${params.toPrefix}${database.name.slice(params.fromPrefix.length)}`
      : database.name,
  }));
  await mkdir(dirname(params.targetPath), { recursive: true });
  await writeFile(params.targetPath, JSON.stringify(rewritten), { mode: 0o600 });
  return true;
}
