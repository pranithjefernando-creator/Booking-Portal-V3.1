import { isValidCode } from "./reference.js";
import { db } from "./db.js";
export const RULE_FIELDS = [
	{ value: "mode", label: "Transport mode", type: "text", operators: ["eq", "neq", "contains"] },
	{ value: "incotermCode", label: "Incoterms", type: "text", operators: ["eq", "neq", "contains"] },
	{ value: "freightTerms", label: "Freight terms", type: "text", operators: ["eq", "neq", "contains"] },
	{ value: "originCode", label: "Origin code", type: "text", operators: ["eq", "neq", "contains"] },
	{ value: "destCode", label: "Destination code", type: "text", operators: ["eq", "neq", "contains"] },
	{ value: "commodityCode", label: "Commodity code", type: "text", operators: ["eq", "neq", "contains"] },
	{ value: "goodsDescription", label: "Goods description", type: "text", operators: ["eq", "neq", "contains"] },
	{ value: "shipperCode", label: "Shipper code", type: "text", operators: ["eq", "neq", "contains"] },
	{ value: "consigneeCode", label: "Consignee code", type: "text", operators: ["eq", "neq", "contains"] },
	{ value: "shipperReferenceNo", label: "Shipper reference", type: "text", operators: ["eq", "neq", "contains"] },
	{ value: "branchCode", label: "Branch code", type: "text", operators: ["eq", "neq", "contains"] },
	{ value: "cargoLines.totalGrossWeightKg", label: "Total gross weight (kg)", type: "number", operators: ["eq", "neq", "gt", "gte", "lt", "lte"] },
	{ value: "cargoLines.totalVolumeM3", label: "Total volume (m3)", type: "number", operators: ["eq", "neq", "gt", "gte", "lt", "lte"] },
	{ value: "cargoLines.totalPackages", label: "Total packages", type: "number", operators: ["eq", "neq", "gt", "gte", "lt", "lte"] },
	{ value: "containers.totalCount", label: "Container count", type: "number", operators: ["eq", "neq", "gt", "gte", "lt", "lte"] },
	{ value: "isDg", label: "Dangerous goods", type: "boolean", operators: ["eq", "neq"] },
	{ value: "pickupRequired", label: "Pickup required", type: "boolean", operators: ["eq", "neq"] }
];
function req(errors, cond, field, msg) { if (!cond) errors.push({ field, message: msg }); }
const isEmpty = (v) => v === undefined || v === null || String(v).trim() === "";
export function validateBooking(b) { const e = []; req(e, !isEmpty(b.shipperCode) || !isEmpty(b.shipper?.companyName), "shipperCode", "Shipper organization is required"); req(e, !isEmpty(b.consigneeCode) || !isEmpty(b.consignee?.companyName), "consigneeCode", "Consignee organization is required"); req(e, !isEmpty(b.mode), "mode", "Mode is required"); req(e, !isEmpty(b.incotermCode), "incotermCode", "Incoterms is required"); req(e, !isEmpty(b.cargoReadyDate), "cargoReadyDate", "Cargo Ready Date is required"); req(e, !isEmpty(b.goodsDescription), "goodsDescription", "Goods Description is required"); if (!isEmpty(b.mode) && !isValidCode("mode", b.mode)) e.push({ field: "mode", message: "Mode not recognised" }); if (!Array.isArray(b.cargoLines) || b.cargoLines.length === 0) e.push({ field: "cargoLines", message: "At least one cargo line is required" }); else b.cargoLines.forEach((l, i) => { req(e, Number(l.packages) > 0, `cargoLines[${i}].packages`, `Cargo line ${i + 1}: Packages must be > 0`); req(e, Number(l.grossWeight) > 0, `cargoLines[${i}].grossWeight`, `Cargo line ${i + 1}: Gross Weight must be > 0`); }); return e; }
function fieldValue(booking, field) {
	if (field === "cargoLines.totalGrossWeightKg") return (booking.cargoLines || []).reduce((sum, line) => sum + (Number(line.grossWeight) || 0) * (String(line.weightUnit || "KGS").toUpperCase() === "LBS" ? 0.4536 : 1), 0);
	if (field === "cargoLines.totalVolumeM3") return (booking.cargoLines || []).reduce((sum, line) => sum + (Number(line.volume) || 0) * (String(line.volumeUnit || "M3").toUpperCase() === "CF" ? 0.0283168 : 1), 0);
	if (field === "cargoLines.totalPackages") return (booking.cargoLines || []).reduce((sum, line) => sum + (Number(line.packages) || 0), 0);
	if (field === "containers.totalCount") return (booking.containers || []).reduce((sum, container) => sum + (Number(container.count) || 0), 0);
	return booking[field];
}
function matchesCondition(booking, condition) {
	const actual = fieldValue(booking, condition.field);
	const field = RULE_FIELDS.find((item) => item.value === condition.field);
	if (!field || !field.operators.includes(condition.operator)) return false;
	if (field.type === "number") {
		const left = Number(actual), right = Number(condition.value);
		if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
		return { eq: left === right, neq: left !== right, gt: left > right, gte: left >= right, lt: left < right, lte: left <= right }[condition.operator];
	}
	if (field.type === "boolean") {
		const left = Boolean(actual), right = condition.value === true || condition.value === "true";
		return condition.operator === "eq" ? left === right : left !== right;
	}
	const left = String(actual ?? "").toLowerCase(), right = String(condition.value ?? "").toLowerCase();
	return condition.operator === "eq" ? left === right : condition.operator === "neq" ? left !== right : left.includes(right);
}
export function evaluateApproval(booking) {
	const user = db.users.find((item) => item.id === booking.createdByUserId) || db.users.find((item) => item.name === booking.createdBy);
	const configurationId = user ? user.ruleConfigurationId : db.ruleConfigurations[0]?.id;
	const configuration = db.ruleConfigurations.find((item) => item.id === configurationId);
	if (!configuration?.enabled) return null;
	const matchedRules = (configuration.rules || []).filter((rule) => rule.enabled !== false && (rule.conditions || []).length > 0).filter((rule) => {
		const checks = rule.conditions.map((condition) => matchesCondition(booking, condition));
		return rule.match === "any" ? checks.some(Boolean) : checks.every(Boolean);
	}).map((rule) => rule.name);
	return matchedRules.length ? matchedRules : null;
}
export function validateOrder(o) { const e = []; req(e, !isEmpty(o.orderNo), "orderNo", "Order No is required"); req(e, !isEmpty(o.orderDate), "orderDate", "Order Date is required"); req(e, !isEmpty(o.transportMode), "transportMode", "Transport Mode is required"); req(e, !isEmpty(o.supplierCode), "supplierCode", "Supplier is required"); req(e, !isEmpty(o.buyerCode), "buyerCode", "Buyer is required"); if (!isEmpty(o.transportMode) && !isValidCode("mode", o.transportMode)) e.push({ field: "transportMode", message: "Transport Mode not recognised" }); return e; }
