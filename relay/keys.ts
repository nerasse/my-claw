import { readFile, rename, writeFile } from "node:fs/promises";

/**
 * The download keys. Only the hash of a key is ever stored: the key itself is shown once, on the
 * page that created it, and the file is worthless to whoever copies it.
 *
 * The relay is the only writer. Keys are created and revoked from the /key page, never by editing
 * the file, so the copy in memory is the truth and the file is its backup.
 */
export interface KeyRecord {
  id: string;
  user: string;
  label: string;
  hash: string;
  created: string;
}

export const KEYS_PER_USER = 20;
export const LABEL_MAX = 60;

export function hashKey(key: string): string {
  return new Bun.CryptoHasher("sha256").update(key).digest("hex");
}

function randomHex(bytes: number): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("hex");
}

function newKey(): string {
  return `mcr_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")}`;
}

function isRecord(value: unknown): value is KeyRecord {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return ["id", "user", "label", "hash", "created"].every((k) => typeof r[k] === "string");
}

export class KeyStore {
  private records: KeyRecord[] = [];
  private writing: Promise<void> = Promise.resolve();

  private constructor(private readonly file: string) {}

  static async open(file: string): Promise<KeyStore> {
    const store = new KeyStore(file);
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return store;
      throw err;
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.every(isRecord)) {
      throw new Error(`${file} is not a list of keys`);
    }
    store.records = parsed;
    return store;
  }

  byKey(key: string): KeyRecord | undefined {
    const hash = hashKey(key);
    return this.records.find((r) => r.hash === hash);
  }

  list(user?: string): KeyRecord[] {
    return user === undefined ? [...this.records] : this.records.filter((r) => r.user === user);
  }

  async create(user: string, label: string): Promise<{ record: KeyRecord; key: string }> {
    if (this.list(user).length >= KEYS_PER_USER) {
      throw new Error(`at most ${KEYS_PER_USER} keys per person: revoke one first`);
    }
    const key = newKey();
    const record: KeyRecord = {
      id: randomHex(4),
      user,
      label,
      hash: hashKey(key),
      created: new Date().toISOString(),
    };
    this.records.push(record);
    try {
      await this.save();
    } catch (err) {
      this.records = this.records.filter((r) => r !== record);
      throw err;
    }
    return { record, key };
  }

  async revoke(id: string): Promise<KeyRecord | undefined> {
    const record = this.records.find((r) => r.id === id);
    if (!record) return undefined;
    // A revocation that fails to reach the disk still holds until the relay restarts: the error
    // is reported, but the key is not handed back its access in the meantime.
    this.records = this.records.filter((r) => r !== record);
    await this.save();
    return record;
  }

  private save(): Promise<void> {
    const snapshot = JSON.stringify(this.records, null, 2);
    const write = this.writing.then(async () => {
      const tmp = `${this.file}.tmp`;
      await writeFile(tmp, snapshot, { mode: 0o600 });
      await rename(tmp, this.file);
    });
    this.writing = write.catch(() => {});
    return write;
  }
}
