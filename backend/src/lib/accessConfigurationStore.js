import { userAccessTransaction } from "./userAccessStore.js";
import { normalizeRuleConfiguration, normalizeVisibilityProfile } from "./accessConfigurationValidation.js";
import { evaluateApprovalConfiguration } from "../validation.js";

function rule(row) {
  return { id: row.id, name: row.name, enabled: row.enabled, rules: row.rules, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() };
}
function profile(row) {
  return { id: row.id, name: row.name, module: row.module, hiddenFields: row.hidden_fields };
}
function normalized(result, key) {
  if (result.error) throw new Error(result.error);
  return result[key];
}
const tables = { rule: "approval_rule_configurations", profile: "visibility_profiles" };
const assignmentNames = { ruleConfigurationId: null, bookingVisibilityProfileId: "booking", orderVisibilityProfileId: "order" };
export const DEFAULT_APPROVAL_ID = "35e6c907-9e36-4aa3-988b-0dcf7de58b18";
const defaultRules = [{ name: "Ocean FCL gross weight > 10,000 KGS", match: "all", enabled: true, conditions: [
  { field: "mode", operator: "eq", value: "Ocean FCL" },
  { field: "cargoLines.totalGrossWeightKg", operator: "gt", value: 10000 }
] }];
const write = (pool, client, operation) => client ? operation(client) : userAccessTransaction(pool, operation);

export async function initializeDefaultApproval(client) {
  const value = normalized(normalizeRuleConfiguration({ name: "Default booking approvals", rules: defaultRules }), "configuration");
  await client.query("INSERT INTO portal_access_v1.approval_rule_configurations (id, name, enabled, rules) VALUES ($1, $2, true, $3::jsonb) ON CONFLICT (id) DO NOTHING", [DEFAULT_APPROVAL_ID, value.name, JSON.stringify(value.rules)]);
}

export async function setUserAssignments(client, id, assignments) {
  if (!assignments || typeof assignments !== "object" || Array.isArray(assignments) || !Object.keys(assignments).length) throw new Error("Assignments are required");
  for (const [key, value] of Object.entries(assignments)) {
    if (!Object.hasOwn(assignmentNames, key)) throw new Error(`Unknown assignment: ${key}`);
    if (value !== null && typeof value !== "string") throw new Error(`Invalid assignment: ${key}`);
  }
  const found = await client.query("SELECT id FROM portal_access_v1.users WHERE id = $1 FOR UPDATE", [id]);
  if (!found.rows.length) return false;
  for (const [key, value] of Object.entries(assignments)) {
    if (key === "ruleConfigurationId") {
      if (!value) await client.query("DELETE FROM portal_access_v1.user_rule_assignments WHERE user_id = $1", [id]);
      else await client.query("INSERT INTO portal_access_v1.user_rule_assignments (user_id, configuration_id) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET configuration_id = EXCLUDED.configuration_id", [id, value]);
    } else {
      const module = assignmentNames[key];
      if (!value) await client.query("DELETE FROM portal_access_v1.user_visibility_assignments WHERE user_id = $1 AND module = $2", [id, module]);
      else await client.query("INSERT INTO portal_access_v1.user_visibility_assignments (user_id, module, profile_id) VALUES ($1, $2, $3) ON CONFLICT (user_id, module) DO UPDATE SET profile_id = EXCLUDED.profile_id", [id, module, value]);
    }
  }
  return true;
}

export function createAccessConfigurationStore(pool) {
  return {
    async listRules() {
      const { rows } = await pool.query("SELECT * FROM portal_access_v1.approval_rule_configurations ORDER BY created_at, id");
      return rows.map(rule);
    },
    async listProfiles() {
      const { rows } = await pool.query("SELECT * FROM portal_access_v1.visibility_profiles ORDER BY name, id");
      return rows.map(profile);
    },
    async createRule(input, client) {
      const value = normalized(normalizeRuleConfiguration(input), "configuration");
      return write(pool, client, async (client) => {
        const { rows } = await client.query("INSERT INTO portal_access_v1.approval_rule_configurations (id, name, enabled, rules) VALUES ($1, $2, $3, $4::jsonb) RETURNING *", [value.id, value.name, value.enabled, JSON.stringify(value.rules)]);
        return rule(rows[0]);
      });
    },
    async updateRule(id, input, client) {
      return write(pool, client, async (client) => {
        const existing = await client.query("SELECT * FROM portal_access_v1.approval_rule_configurations WHERE id = $1 FOR UPDATE", [id]);
        if (!existing.rows.length) return null;
        const value = normalized(normalizeRuleConfiguration(input, rule(existing.rows[0])), "configuration");
        const { rows } = await client.query("UPDATE portal_access_v1.approval_rule_configurations SET name = $2, enabled = $3, rules = $4::jsonb, updated_at = clock_timestamp() WHERE id = $1 RETURNING *", [id, value.name, value.enabled, JSON.stringify(value.rules)]);
        return rule(rows[0]);
      });
    },
    async createProfile(input, client) {
      const value = normalized(normalizeVisibilityProfile(input), "profile");
      return write(pool, client, async (client) => {
        const { rows } = await client.query("INSERT INTO portal_access_v1.visibility_profiles (id, name, module, hidden_fields) VALUES ($1, $2, $3, $4::jsonb) RETURNING *", [value.id, value.name, value.module, JSON.stringify(value.hiddenFields)]);
        return profile(rows[0]);
      });
    },
    async updateProfile(id, input, client) {
      return write(pool, client, async (client) => {
        const existing = await client.query("SELECT * FROM portal_access_v1.visibility_profiles WHERE id = $1 FOR UPDATE", [id]);
        if (!existing.rows.length) return null;
        const value = normalized(normalizeVisibilityProfile(input, profile(existing.rows[0])), "profile");
        const { rows } = await client.query("UPDATE portal_access_v1.visibility_profiles SET name = $2, module = $3, hidden_fields = $4::jsonb WHERE id = $1 RETURNING *", [id, value.name, value.module, JSON.stringify(value.hiddenFields)]);
        return profile(rows[0]);
      });
    },
    async deleteRule(id, client) {
      if (id === DEFAULT_APPROVAL_ID) { const error = new Error("The default approval configuration cannot be deleted"); error.code = "DEFAULT_RULE"; throw error; }
      return write(pool, client, async (client) => (await client.query(`DELETE FROM portal_access_v1.${tables.rule} WHERE id = $1 RETURNING id`, [id])).rows.length > 0);
    },
    async deleteProfile(id, client) {
      return write(pool, client, async (client) => (await client.query(`DELETE FROM portal_access_v1.${tables.profile} WHERE id = $1 RETURNING id`, [id])).rows.length > 0);
    },
    async setAssignments(id, assignments, client) {
      return write(pool, client, (client) => setUserAssignments(client, id, assignments));
    },
    async getUserConfiguration(id) {
      return userAccessTransaction(pool, async (client) => {
        const found = await client.query("SELECT id FROM portal_access_v1.users WHERE id = $1", [id]);
        if (!found.rows.length) return null;
        const configurations = await client.query("SELECT c.* FROM portal_access_v1.approval_rule_configurations c JOIN portal_access_v1.user_rule_assignments a ON a.configuration_id = c.id WHERE a.user_id = $1", [id]);
        const profiles = await client.query("SELECT p.* FROM portal_access_v1.visibility_profiles p JOIN portal_access_v1.user_visibility_assignments a ON a.profile_id = p.id AND a.module = p.module WHERE a.user_id = $1", [id]);
        const visibility = { booking: [], order: [] };
        const assignments = { ruleConfigurationId: configurations.rows[0]?.id || "", bookingVisibilityProfileId: "", orderVisibilityProfileId: "" };
        for (const row of profiles.rows) {
          if (!Object.hasOwn(visibility, row.module)) throw new Error(`Unknown visibility module: ${row.module}`);
          visibility[row.module] = row.hidden_fields;
          assignments[`${row.module}VisibilityProfileId`] = row.id;
        }
        return { assignments, configuration: configurations.rows.length ? rule(configurations.rows[0]) : null, fieldVisibility: visibility };
      }, true);
    },
    async evaluateUserApproval(id, booking) {
      const settings = await this.getUserConfiguration(id);
      if (!settings) throw new Error("User not found");
      return evaluateApprovalConfiguration(booking, settings.configuration);
    },
    async evaluateBookingApproval(booking) {
      return userAccessTransaction(pool, async (client) => {
        let creator;
        if (typeof booking.createdByUserId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(booking.createdByUserId)) {
          creator = (await client.query("SELECT id FROM portal_access_v1.users WHERE id = $1", [booking.createdByUserId])).rows[0];
        }
        if (!creator && booking.createdBy) {
          const matches = await client.query("SELECT id FROM portal_access_v1.users WHERE name = $1 LIMIT 2", [booking.createdBy]);
          if (matches.rows.length > 1) throw new Error("Booking creator name matches multiple users");
          creator = matches.rows[0];
        }
        const result = creator
          ? await client.query("SELECT c.* FROM portal_access_v1.approval_rule_configurations c JOIN portal_access_v1.user_rule_assignments a ON a.configuration_id = c.id WHERE a.user_id = $1", [creator.id])
          : await client.query("SELECT * FROM portal_access_v1.approval_rule_configurations WHERE id = $1", [DEFAULT_APPROVAL_ID]);
        if (!creator && !result.rows.length) throw new Error("Default approval configuration is missing");
        return evaluateApprovalConfiguration(booking, result.rows.length ? rule(result.rows[0]) : null);
      }, true);
    }
  };
}
