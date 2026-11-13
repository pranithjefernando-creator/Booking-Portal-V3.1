import { MODULES, PERMISSIONS, defaultRoles, effectiveModules } from "../rbac.js";
import { canSeeBooking, canSeeOrder, userHasOrderAccess } from "../db.js";
import { canSeeTracking } from "./trackingAccess.js";
import { userAccessTransaction } from "./userAccessStore.js";

const scopes = {
  bookingOrgs: "booking", bookingShipperOrgs: "booking_shipper", bookingConsigneeOrgs: "booking_consignee",
  orderOrgs: "order", orderSupplierOrgs: "order_supplier", orderBuyerOrgs: "order_buyer", trackingOrgs: "tracking"
};
const scopeFields = Object.fromEntries(Object.entries(scopes).map(([field, type]) => [type, field]));
const write = (pool, client, operation) => client ? operation(client) : userAccessTransaction(pool, operation);

function codes(values, name) {
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string" || !value || value !== value.trim())) throw new Error(`${name} must be an array of nonempty trimmed strings`);
  if (new Set(values).size !== values.length) throw new Error(`${name} contains duplicates`);
  return values;
}

function roleInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Role must be an object");
  for (const key of Object.keys(input)) if (!["name", "description", "permissions", "modules"].includes(key)) throw new Error(`Unsupported role field: ${key}`);
  if (typeof input.name !== "string" || !input.name.trim() || input.name !== input.name.trim()) throw new Error("Role name must be nonempty and trimmed");
  if (typeof input.description !== "string") throw new Error("Role description must be a string");
  codes(input.permissions, "permissions");
  codes(input.modules, "modules");
}

async function loadRole(client, name) {
  const result = await client.query("SELECT name, description, builtin FROM portal_access_v1.roles WHERE name = $1", [name]);
  if (!result.rows.length) return null;
  const permissions = await client.query("SELECT permission_code FROM portal_access_v1.role_permissions WHERE role_name = $1 ORDER BY permission_code", [name]);
  const modules = await client.query("SELECT module_code FROM portal_access_v1.role_modules WHERE role_name = $1 ORDER BY position", [name]);
  return { ...result.rows[0], permissions: permissions.rows.map((row) => row.permission_code), modules: modules.rows.map((row) => row.module_code) };
}

async function replaceRoleGrants(client, role) {
  await client.query("DELETE FROM portal_access_v1.role_permissions WHERE role_name = $1", [role.name]);
  await client.query("DELETE FROM portal_access_v1.role_modules WHERE role_name = $1", [role.name]);
  for (const code of role.permissions) await client.query("INSERT INTO portal_access_v1.role_permissions (role_name, permission_code) VALUES ($1, $2)", [role.name, code]);
  for (const [position, code] of role.modules.entries()) await client.query("INSERT INTO portal_access_v1.role_modules (role_name, module_code, position) VALUES ($1, $2, $3)", [role.name, code, position]);
}

export async function initializeAccessCatalogs(client) {
  for (const [code, label] of Object.entries(PERMISSIONS)) await client.query("INSERT INTO portal_access_v1.permissions (code, label) VALUES ($1, $2) ON CONFLICT (code) DO NOTHING", [code, label]);
  for (const [code, label] of Object.entries(MODULES)) await client.query("INSERT INTO portal_access_v1.modules (code, label) VALUES ($1, $2) ON CONFLICT (code) DO NOTHING", [code, label]);
  for (const [name, role] of Object.entries(defaultRoles())) {
    const inserted = await client.query("INSERT INTO portal_access_v1.roles (name, description, builtin) VALUES ($1, $2, true) ON CONFLICT (name) DO NOTHING RETURNING name", [name, role.description]);
    if (inserted.rows.length) await replaceRoleGrants(client, { name, ...role });
  }
}

async function loadAccess(client, id) {
  const result = await client.query("SELECT id, name, email, role_name, branch_code, modules_configured, created_at, updated_at FROM portal_access_v1.users WHERE id = $1", [id]);
  if (!result.rows.length) return null;
  const row = result.rows[0];
  const role = await loadRole(client, row.role_name);
  if (!role) throw new Error(`Missing role for user ${id}`);
  const modules = await client.query("SELECT module_code FROM portal_access_v1.user_modules WHERE user_id = $1 ORDER BY position", [id]);
  const savedScopes = await client.query("SELECT scope_type, organization_code FROM portal_access_v1.user_organization_scopes WHERE user_id = $1 ORDER BY scope_type, position", [id]);
  const user = {
    id: row.id, name: row.name, email: row.email, role: row.role_name, branchCode: row.branch_code,
    modulesConfigured: row.modules_configured, modules: modules.rows.map((item) => item.module_code),
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
    ...Object.fromEntries(Object.keys(scopes).map((field) => [field, []]))
  };
  for (const item of savedScopes.rows) {
    const field = scopeFields[item.scope_type];
    if (!field) throw new Error(`Unsupported stored scope: ${item.scope_type}`);
    user[field].push(item.organization_code);
  }
  return { user, role };
}

export function accessChecks(snapshot) {
  if (!snapshot?.user || !snapshot.role || snapshot.user.role !== snapshot.role.name) throw new Error("A matching user and role snapshot is required");
  const { user, role } = snapshot;
  return {
    hasPermission: (permission) => role.permissions.includes(permission),
    modules: effectiveModules(user, role),
    canSeeBooking: (booking) => canSeeBooking(user, booking),
    canSeeOrder: (order) => canSeeOrder(user, order),
    canCreateOrder: () => userHasOrderAccess(user),
    canSeeTracking: (record) => canSeeTracking(user, record, role)
  };
}

export function createUserAccessSettingsStore(pool) {
  return {
    async initializeCatalogs() {
      return userAccessTransaction(pool, initializeAccessCatalogs);
    },
    async listRoles(client) {
      const read = async (client) => {
        const { rows } = await client.query("SELECT name FROM portal_access_v1.roles ORDER BY name");
        const roles = [];
        for (const row of rows) roles.push(await loadRole(client, row.name));
        return roles;
      };
      return client ? read(client) : userAccessTransaction(pool, read, true);
    },
    async createRole(role, client) {
      roleInput(role);
      if (role.name === "Admin") throw new Error("The Admin role is reserved");
      return write(pool, client, async (client) => {
        await client.query("INSERT INTO portal_access_v1.roles (name, description, builtin) VALUES ($1, $2, false)", [role.name, role.description]);
        await replaceRoleGrants(client, role);
        return loadRole(client, role.name);
      });
    },
    async updateRole(role, client) {
      roleInput(role);
      if (role.name === "Admin") throw new Error("The Admin role cannot be changed");
      return write(pool, client, async (client) => {
        const result = await client.query("UPDATE portal_access_v1.roles SET description = $2 WHERE name = $1 RETURNING name", [role.name, role.description]);
        if (!result.rows.length) return null;
        await replaceRoleGrants(client, role);
        return loadRole(client, role.name);
      });
    },
    async deleteRole(name, client) {
      if (typeof name !== "string" || !name) throw new Error("Role name is required");
      if (name === "Admin") throw new Error("The Admin role cannot be deleted");
      return write(pool, client, async (client) => {
        const result = await client.query("DELETE FROM portal_access_v1.roles WHERE name = $1 RETURNING name", [name]);
        return result.rows.length > 0;
      });
    },
    async getAccess(id, client) {
      return client ? loadAccess(client, id) : userAccessTransaction(pool, (connection) => loadAccess(connection, id), true);
    },
    async setModules(id, modules, client) {
      if (modules !== null) codes(modules, "modules");
      return write(pool, client, async (client) => {
        const user = await client.query("SELECT id FROM portal_access_v1.users WHERE id = $1 FOR UPDATE", [id]);
        if (!user.rows.length) return null;
        await client.query("DELETE FROM portal_access_v1.user_modules WHERE user_id = $1", [id]);
        for (const [position, code] of (modules || []).entries()) await client.query("INSERT INTO portal_access_v1.user_modules (user_id, module_code, position) VALUES ($1, $2, $3)", [id, code, position]);
        await client.query("UPDATE portal_access_v1.users SET modules_configured = $2, updated_at = clock_timestamp() WHERE id = $1", [id, modules !== null]);
        return loadAccess(client, id);
      });
    },
    async setScopes(id, changes, client) {
      if (!changes || typeof changes !== "object" || Array.isArray(changes) || !Object.keys(changes).length) throw new Error("At least one scope is required");
      for (const [field, values] of Object.entries(changes)) {
        if (!Object.hasOwn(scopes, field)) throw new Error(`Unsupported scope: ${field}`);
        codes(values, field);
      }
      return write(pool, client, async (client) => {
        const snapshot = await loadAccess(client, id);
        if (!snapshot) return null;
        const next = Object.fromEntries(Object.keys(scopes).map((field) => [field, changes[field] || snapshot.user[field]]));
        for (const [parent, children] of [["bookingOrgs", ["bookingShipperOrgs", "bookingConsigneeOrgs"]], ["orderOrgs", ["orderSupplierOrgs", "orderBuyerOrgs"]]]) {
          if (Object.hasOwn(changes, parent)) {
            const allowed = new Set(next[parent]);
            for (const child of children) if (!Object.hasOwn(changes, child)) next[child] = next[child].filter((code) => allowed.has(code));
          }
          if (next[parent].length) for (const child of children) if (next[child].some((code) => !next[parent].includes(code))) {
            const error = new Error(`${child} must be within ${parent}`);
            error.code = "INVALID_SCOPE";
            throw error;
          }
        }
        await client.query("DELETE FROM portal_access_v1.user_organization_scopes WHERE user_id = $1", [id]);
        for (const [field, type] of Object.entries(scopes)) for (const [position, code] of next[field].entries()) await client.query("INSERT INTO portal_access_v1.user_organization_scopes (user_id, scope_type, organization_code, position) VALUES ($1, $2, $3, $4)", [id, type, code, position]);
        await client.query("UPDATE portal_access_v1.users SET updated_at = clock_timestamp() WHERE id = $1", [id]);
        return loadAccess(client, id);
      });
    }
  };
}
