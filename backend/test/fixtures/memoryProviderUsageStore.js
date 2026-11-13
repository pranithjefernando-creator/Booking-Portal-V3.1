export function memoryProviderUsageStore() {
  let timestamps = [];
  let month = "";
  let count = 0;
  let blockedUntil = 0;
  function refresh() {
    const now = new Date();
    const currentMonth = `${now.getUTCFullYear()}-${now.getUTCMonth()}`;
    if (month !== currentMonth) { month = currentMonth; count = 0; }
    timestamps = timestamps.filter((timestamp) => Date.now() - timestamp < 60000);
  }
  return {
    async reserve(rateLimit, monthlyQuota) {
      refresh();
      if (Date.now() < blockedUntil || timestamps.length >= rateLimit || count >= monthlyQuota) return null;
      timestamps.push(Date.now());
      count++;
      return { account: "test", environment: "test" };
    },
    async recordBackoff(_scope, delay) { blockedUntil = Math.max(blockedUntil, Date.now() + delay); },
    async stats() {
      refresh();
      return { callsThisMonth: count, callsLastMinute: timestamps.length };
    }
  };
}
