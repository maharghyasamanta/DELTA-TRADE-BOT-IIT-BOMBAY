interface CacheEntry<T> {
  value: T;
  storedAt: number;
  expiresAt: number;
}

export class TtlCache<T> {
  private readonly store = new Map<string, CacheEntry<T>>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(ttlMs: number, maxEntries = 250) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
  }

  get(key: string): { value: T; ageMs: number } | null {
    const entry = this.store.get(key);
    if (!entry) {
      return null;
    }
    const now = Date.now();
    if (now >= entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return { value: entry.value, ageMs: now - entry.storedAt };
  }

  set(key: string, value: T): void {
    const now = Date.now();
    if (this.store.size >= this.maxEntries) {
      this.pruneExpired(now);
      if (this.store.size >= this.maxEntries) {
        const oldestKey = this.store.keys().next().value;
        if (oldestKey !== undefined) {
          this.store.delete(oldestKey);
        }
      }
    }
    this.store.set(key, {
      value,
      storedAt: now,
      expiresAt: now + this.ttlMs,
    });
  }

  get size(): number {
    this.pruneExpired(Date.now());
    return this.store.size;
  }

  private pruneExpired(now: number): void {
    for (const [k, entry] of this.store.entries()) {
      if (now >= entry.expiresAt) {
        this.store.delete(k);
      }
    }
  }
}
