/**
 * Simple LRU Map. Evicts oldest entries when maxSize is exceeded.
 * Relies on Map insertion order (ES2015+). A `get` moves the entry to the end
 * (most-recently-used).
 */
export class LruMap<K, V> extends Map<K, V> {
  private readonly onEvict?: (key: K, value: V) => void;

  constructor(maxSize: number, onEvict?: (key: K, value: V) => void) {
    super();
    this._maxSize = maxSize;
    this.onEvict = onEvict;
  }

  private _maxSize: number;
  get maxSize(): number {
    return this._maxSize;
  }

  override get(key: K): V | undefined {
    const value = super.get(key);
    if (value !== undefined) {
      // Move to end (most-recently-used)
      super.delete(key);
      super.set(key, value);
    }
    return value;
  }

  override set(key: K, value: V): this {
    if (super.has(key)) {
      super.delete(key);
    }
    super.set(key, value);
    this.evict();
    return this;
  }

  private evict(): void {
    while (this.size > this._maxSize) {
      const oldest = this.keys().next().value;
      if (oldest !== undefined) {
        if (this.onEvict) {
          const value = super.get(oldest);
          if (value !== undefined) this.onEvict(oldest, value);
        }
        super.delete(oldest);
      } else {
        break;
      }
    }
  }
}

/**
 * TTL-pruned Set. Entries expire after `ttlMs`. Pruned lazily on `add`.
 */
export class TtlSet<V> {
  private readonly entries = new Map<V, number>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxSize: number = 10_000,
  ) {}

  add(value: V): void {
    this.entries.set(value, Date.now());
    this.prune();
  }

  has(value: V): boolean {
    const ts = this.entries.get(value);
    if (ts === undefined) return false;
    if (Date.now() - ts > this.ttlMs) {
      this.entries.delete(value);
      return false;
    }
    return true;
  }

  delete(value: V): boolean {
    return this.entries.delete(value);
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }

  prune(): void {
    const now = Date.now();
    for (const [key, ts] of this.entries) {
      if (now - ts > this.ttlMs) {
        this.entries.delete(key);
      }
    }
    while (this.entries.size > this.maxSize) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) {
        this.entries.delete(oldest);
      } else {
        break;
      }
    }
  }
}
