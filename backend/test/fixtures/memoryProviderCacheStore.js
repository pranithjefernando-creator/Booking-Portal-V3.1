export function memoryProviderCacheStore() {
  const tracking = new Map();
  const ports = new Map();
  return {
    async getTracking(key) {
      const entry = tracking.get(key);
      return entry && entry.expiresAt > Date.now() ? entry : null;
    },
    async putTracking(key, result, error, fetchedAt, ttl) {
      tracking.set(key, { result, error, expiresAt: fetchedAt + ttl });
    },
    async getPort(code) {
      const entry = ports.get(code);
      return entry && entry.expiresAt > Date.now() ? entry : null;
    },
    async getPortForRetry(code) { return ports.get(code) || null; },
    async putPort(code, result, fetchedAt, ttl) {
      ports.set(code, { result, fetched_at: new Date(fetchedAt), expiresAt: fetchedAt + ttl });
    },
    async countPorts() { return ports.size; }
  };
}
