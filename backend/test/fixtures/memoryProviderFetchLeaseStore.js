import { randomUUID } from "node:crypto";

export function memoryProviderFetchLeaseStore() {
  const leases = new Map();
  return {
    async claim(kind, key) {
      const composite = JSON.stringify([kind, key]);
      const existing = leases.get(composite);
      if (existing) return { owner: false, id: existing.id, state: existing.state, expired: false };
      const id = randomUUID();
      leases.set(composite, { id, state: "active" });
      return { owner: true, id };
    },
    async assertOwner(id) {
      if (![...leases.values()].some((lease) => lease.id === id && lease.state === "active")) {
        throw Object.assign(new Error("Provider request requires review"), { code: "PROVIDER_REQUEST_UNCERTAIN" });
      }
    },
    async markUncertain(id) {
      const lease = [...leases.values()].find((item) => item.id === id);
      if (lease) lease.state = "uncertain";
    },
    async cancel(id) {
      for (const [key, lease] of leases) if (lease.id === id && lease.state === "active") leases.delete(key);
    },
    async complete(id, write) {
      await this.assertOwner(id);
      await write();
      await this.cancel(id);
    }
  };
}
