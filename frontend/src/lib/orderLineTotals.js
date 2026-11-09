function sumLineValues(lines, field) {
  const values = lines
    .map((line) => line[field])
    .filter((value) => value !== "" && value != null)
    .map(Number)
    .filter(Number.isFinite);
  return values.length ? values.reduce((total, value) => total + value, 0) : "";
}

function firstLineValue(lines, field) {
  return lines.find((line) => String(line[field] ?? "").trim())?.[field] || "";
}

export function orderLineTotals(lines = []) {
  return {
    weight: sumLineValues(lines, "weight"),
    weightUom: firstLineValue(lines, "weightUom"),
    volume: sumLineValues(lines, "volume"),
    volumeUom: firstLineValue(lines, "volumeUom"),
    quantity: sumLineValues(lines, "outerPacks"),
    quantityUom: firstLineValue(lines, "outerPacksType")
  };
}
