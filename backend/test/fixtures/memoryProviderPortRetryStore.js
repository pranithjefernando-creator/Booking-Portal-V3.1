import { randomUUID } from "node:crypto";

export function memoryProviderPortRetryStore() {
  const jobs = new Map();
  return {
    async schedule(code, fetchedAt) {
      jobs.set(code, { retry_id: randomUUID(), port_code: code, cache_fetched_at: new Date(fetchedAt), dueAt: Date.now() + 60000 });
    },
    async discardPort(code) { jobs.delete(code); },
    async discard(id) { for (const [code, job] of jobs) if (job.retry_id === id) jobs.delete(code); },
    async getDue(id) { return [...jobs.values()].find((job) => job.retry_id === id && job.dueAt <= Date.now()) || null; },
    async listDue() { return [...jobs.values()].filter((job) => job.dueAt <= Date.now()); }
  };
}
