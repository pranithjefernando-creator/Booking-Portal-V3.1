import { orderLineTotals } from "./orderLineTotals.js";

function valueOrEmpty(value) {
  return value == null ? "" : String(value);
}

export function cargoValuesFromOrder(order) {
  const details = order.orderLines?.length ? orderLineTotals(order.orderLines) : order;
  return {
    packages: valueOrEmpty(details.quantity),
    packageTypeCode: valueOrEmpty(details.quantityUom),
    grossWeight: valueOrEmpty(details.weight),
    weightUnit: valueOrEmpty(details.weightUom),
    volume: valueOrEmpty(details.volume),
    volumeUnit: valueOrEmpty(details.volumeUom)
  };
}
