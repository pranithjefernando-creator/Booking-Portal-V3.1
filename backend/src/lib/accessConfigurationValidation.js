import { randomUUID } from "node:crypto";
import { FIELD_CATALOG } from "../fieldVisibilityCatalog.js";
import { RULE_FIELDS } from "../validation.js";

export function normalizeVisibilityProfile(input, existing = {}) {
  if (typeof input?.name !== "string" || !input.name.trim()) return { error: "Profile name is required" };
  if (!Object.hasOwn(FIELD_CATALOG, input.module)) return { error: "Invalid profile module" };
  if (!Array.isArray(input.hiddenFields)) return { error: "Hidden fields must be an array" };
  const fields = new Map(FIELD_CATALOG[input.module].map((field) => [field.key, field]));
  if (input.hiddenFields.some((key) => typeof key !== "string" || !fields.has(key) || fields.get(key).required)) return { error: "Hidden fields must be recognized optional fields" };
  return { profile: { id: existing.id || randomUUID(), name: input.name.trim(), module: input.module, hiddenFields: [...new Set(input.hiddenFields)] } };
}

export function normalizeRuleConfiguration(input, existing = {}) {
  const name = String(input?.name || "").trim();
  if (!name) return { error: "Configuration name is required" };
  if (!Array.isArray(input?.rules)) return { error: "Rules must be an array" };
  const rules = [];
  for (const rule of input.rules) {
    const ruleName = String(rule?.name || "").trim();
    if (!ruleName) return { error: "Every rule needs a name" };
    if (!Array.isArray(rule.conditions) || rule.conditions.length === 0) return { error: `Rule '${ruleName}' needs at least one condition` };
    const conditions = [];
    for (const condition of rule.conditions) {
      const field = RULE_FIELDS.find((item) => item.value === condition?.field);
      if (!field || !field.operators.includes(condition.operator)) return { error: `Invalid condition in rule '${ruleName}'` };
      if (condition.value === undefined || condition.value === null || String(condition.value).trim() === "") return { error: `Condition value is required in rule '${ruleName}'` };
      if (field.type === "number" && !Number.isFinite(Number(condition.value))) return { error: `Condition value must be numeric for ${field.label}` };
      conditions.push({ id: condition.id || randomUUID(), field: field.value, operator: condition.operator, value: field.type === "number" ? Number(condition.value) : condition.value });
    }
    rules.push({ id: rule.id || randomUUID(), name: ruleName, enabled: rule.enabled !== false, match: rule.match === "any" ? "any" : "all", conditions });
  }
  return { configuration: { id: existing.id || randomUUID(), name, enabled: input.enabled !== false, rules, updatedAt: new Date().toISOString(), createdAt: existing.createdAt || new Date().toISOString() } };
}
