const CACHE_TTL = 5 * 60 * 1000;
const CLEANUP_INTERVAL = 10 * 60 * 1000;

function createCache() {
  const store = new Map();

  const timer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store) {
      if (now - entry.ts >= CACHE_TTL) store.delete(key);
    }
  }, CLEANUP_INTERVAL);
  timer.unref();

  return {
    get(key) {
      const entry = store.get(key);
      if (entry && Date.now() - entry.ts < CACHE_TTL) return entry.data;
      store.delete(key);
      return null;
    },
    set(key, data) {
      store.set(key, { data, ts: Date.now() });
    },
  };
}

module.exports = { createCache };
