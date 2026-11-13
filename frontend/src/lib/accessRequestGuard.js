export function createAccessRequestGuard(identity) {
  let generation = 0;
  return {
    begin() {
      const request = ++generation;
      const snapshot = identity();
      return () => generation === request && identity() === snapshot;
    },
    invalidate() { generation++; }
  };
}
