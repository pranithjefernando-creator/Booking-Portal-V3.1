function comparable(value) {
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "boolean") return value ? "true" : "false";
  return value == null ? "" : String(value);
}

export function applySearchFilters(records, filters, getValue = (record, field) => record[field]) {
  const active = (filters || []).filter((filter) => filter.field && filter.operator && filter.value !== "" && filter.value != null);
  if (!active.length) return records || [];

  return (records || []).filter((record) => active.every((filter) => {
    const raw = getValue(record, filter.field);
    if (raw == null || raw === "") return false;
    const value = comparable(raw);
    const expected = String(filter.value).trim();
    if (filter.type === "number") {
      const actualNumber = Number(raw);
      const expectedNumber = Number(expected);
      if (!Number.isFinite(actualNumber) || !Number.isFinite(expectedNumber)) return false;
      return {
        eq: actualNumber === expectedNumber,
        neq: actualNumber !== expectedNumber,
        gt: actualNumber > expectedNumber,
        gte: actualNumber >= expectedNumber,
        lt: actualNumber < expectedNumber,
        lte: actualNumber <= expectedNumber
      }[filter.operator] ?? false;
    }

    const actualText = (filter.type === "date" ? value.slice(0, 10) : value).toLowerCase();
    const expectedText = (filter.type === "date" ? expected.slice(0, 10) : expected).toLowerCase();
    if (filter.operator === "contains") return actualText.includes(expectedText);
    if (filter.operator === "neq") return actualText !== expectedText;
    if (filter.operator === "gt") return actualText > expectedText;
    if (filter.operator === "gte") return actualText >= expectedText;
    if (filter.operator === "lt") return actualText < expectedText;
    if (filter.operator === "lte") return actualText <= expectedText;
    return actualText === expectedText;
  }));
}
