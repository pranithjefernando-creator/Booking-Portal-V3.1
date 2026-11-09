function isEmpty(value) {
  return value == null || value === "";
}

function compareValues(left, right) {
  if (isEmpty(left)) return isEmpty(right) ? 0 : 1;
  if (isEmpty(right)) return -1;
  if (typeof left === "number" && typeof right === "number") return left - right;

  const leftText = String(left);
  const rightText = String(right);
  const leftNumber = Number(leftText);
  const rightNumber = Number(rightText);
  if (leftText.trim() && rightText.trim() && Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
    return leftNumber - rightNumber;
  }
  return leftText.localeCompare(rightText, undefined, { numeric: true, sensitivity: "base" });
}

export function sortRecords(records, key, direction = "asc", getValue = (record, field) => record[field]) {
  if (!key || !Array.isArray(records)) return records || [];
  const multiplier = direction === "desc" ? -1 : 1;
  return [...records].sort((left, right) => {
    const leftValue = getValue(left, key);
    const rightValue = getValue(right, key);
    if (isEmpty(leftValue) || isEmpty(rightValue)) return compareValues(leftValue, rightValue);
    return compareValues(leftValue, rightValue) * multiplier;
  });
}
