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
