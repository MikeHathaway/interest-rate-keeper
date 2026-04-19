const registeredClearables = new Set<() => void>();

/**
 * Register a cache-clearing callback. All callbacks fire when
 * `clearAllRegisteredAjnaCaches` is invoked. Typically each module calls this
 * once at module load with a one-line `() => myCache.clear()` closure.
 */
export function registerAjnaCacheClearable(clear: () => void): void {
  registeredClearables.add(clear);
}

/**
 * Invoke every registered clear callback. Used by `clearAjnaSnapshotCaches`
 * so caller modules do not need to import and coordinate each cache clearer
 * individually.
 */
export function clearAllRegisteredAjnaCaches(): void {
  for (const clear of registeredClearables) {
    clear();
  }
}

export function setBoundedCacheEntry<K, V>(
  cache: Map<K, V>,
  key: K,
  value: V,
  maxEntries: number
): void {
  if (cache.has(key)) {
    cache.delete(key);
  }

  cache.set(key, value);

  while (cache.size > maxEntries) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) {
      break;
    }
    cache.delete(oldestKey);
  }
}

export function buildSimulationCacheKey(
  parts: Array<string | number | bigint | undefined>
): string {
  return parts
    .map((part) => {
      if (part === undefined) {
        return "-";
      }

      return typeof part === "bigint" ? part.toString() : String(part);
    })
    .join(":");
}
