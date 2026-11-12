export function cargoLinkedOrderIds(cargoLines, linkedIds) {
  return new Set(cargoLines.map((line) => line.orderId).filter((orderId) => linkedIds.has(orderId)));
}

export function planCargoOrderLinks(cargoLines, linkedIds, cargoIds) {
  const selected = new Set(cargoLines.map((line) => line.orderId).filter(Boolean));
  return {
    selected,
    toLink: [...selected].filter((id) => !linkedIds.has(id)),
    toUnlink: [...cargoIds].filter((id) => !selected.has(id))
  };
}
