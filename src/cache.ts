/**
 * Get-or-fetch cache for slow P5 lookups, backed by the table p5_cache of the
 * catalogue database. A fresh entry (younger than the TTL) is returned as is;
 * an expired one is refetched; when the fetch fails (P5 unreachable) the
 * expired entry is returned and marked stale. Without a store or with ttl 0 the
 * fetch runs every time. The web page (web/src/server.ts) carries a copy of
 * this helper: it is a separate build without access to src/.
 */

export interface CacheStore {
  /** Entry for key with its age in seconds (computed by the database), or null. */
  get(k: string): Promise<{ v: string; ageS: number } | null>;
  put(k: string, v: string): Promise<void>;
}

export interface Cached<T> {
  value: T;
  /** off: no cache; miss: fetched; hit: served from cache; stale: P5 failed, expired entry served */
  cache: "off" | "miss" | "hit" | "stale";
  ageS?: number;
  /** why the fetch failed (stale only) */
  error?: string;
}

export const SCHEMA_P5_CACHE = `CREATE TABLE IF NOT EXISTS p5_cache (
  k VARCHAR(255) NOT NULL PRIMARY KEY,
  v LONGTEXT NULL,
  fetched_at DATETIME NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;

export async function getOrFetch<T>(store: CacheStore | null, ttlMinutes: number, key: string, fetch: () => Promise<T>): Promise<Cached<T>> {
  if (!store || !(ttlMinutes > 0)) return { value: await fetch(), cache: "off" };
  let hit: { value: T; ageS: number } | null = null;
  try {
    const row = await store.get(key);
    if (row) hit = { value: JSON.parse(row.v) as T, ageS: row.ageS };
  } catch {
    hit = null; // an unreadable cache is a miss, never an error
  }
  if (hit && hit.ageS < ttlMinutes * 60) return { value: hit.value, cache: "hit", ageS: hit.ageS };
  try {
    const value = await fetch();
    try {
      await store.put(key, JSON.stringify(value));
    } catch {
      /* cache write failed: the fresh value is still returned */
    }
    return { value, cache: "miss" };
  } catch (e) {
    if (hit) return { value: hit.value, cache: "stale", ageS: hit.ageS, error: (e as Error).message };
    throw e;
  }
}
