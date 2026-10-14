/**
 * Tiny in-memory cache for the seat map. Concurrent requests during a miss share
 * one database query instead of each running their own. In production with several
 * app servers this would live in Redis; the interface would stay the same.
 */
export function createSeatMapCache(ttlMs) {
  const entries = new Map();

  return {
    get(key, load) {
      if (ttlMs <= 0) return load();
      const hit = entries.get(key);
      if (hit && hit.expiresAt > Date.now()) return hit.promise;

      const promise = load();
      entries.set(key, { promise, expiresAt: Date.now() + ttlMs });
      promise.catch(() => entries.delete(key));
      return promise;
    },
    clear() {
      entries.clear();
    },
  };
}
