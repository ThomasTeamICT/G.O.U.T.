// Klein hand-gerold opruimmechanisme voor de in-memory caches, zodat ze niet
// onbegrensd groeien. Bij een nieuwe key (map al op/over de drempel) vegen we
// eerst verlopen entries weg en dwingen daarna een harde maxgrootte af door de
// oudste (eerst-ingevoegde) entries te verwijderen — een Map behoudt de
// insertievolgorde, dus de eerste key is de oudste. Verwacht waarden met een
// `.t` (Date.now()-tijdstempel) voor de TTL-veeg.
export function cacheSet(map, key, value, { max, ttl }) {
  if (!map.has(key) && map.size >= max) {
    const now = Date.now();
    if (ttl) {
      for (const [k, v] of map) if (now - v.t >= ttl) map.delete(k);
    }
    while (map.size >= max) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }
  map.set(key, value);
}
