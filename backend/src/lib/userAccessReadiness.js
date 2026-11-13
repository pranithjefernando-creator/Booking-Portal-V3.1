import { DEFAULT_APPROVAL_ID } from "./accessConfigurationStore.js";
import { normalizeRuleConfiguration } from "./accessConfigurationValidation.js";
import { USER_ACCESS_TABLES } from "./userAccessSchema.js";

export async function verifyUserAccessRuntime(client, schema = "portal_access_v1") {
  if (!/^[a-z_][a-z0-9_]*$/.test(schema) || schema.length > 63) throw new Error("Invalid user access schema name");
  const probes = USER_ACCESS_TABLES.map((table, index) => `EXISTS (SELECT 1 FROM "${schema}"."${table}" LIMIT 1) AS probe_${index}`);
  await client.query(`SELECT ${probes.join(", ")}`);
  const { rows } = await client.query(`SELECT name, enabled, rules FROM "${schema}".approval_rule_configurations WHERE id = $1`, [DEFAULT_APPROVAL_ID]);
  if (!rows.length) throw new Error("Default approval configuration is missing");
  const validation = normalizeRuleConfiguration(rows[0]);
  if (validation.error) throw new Error(`Default approval configuration is invalid: ${validation.error}`);
}
