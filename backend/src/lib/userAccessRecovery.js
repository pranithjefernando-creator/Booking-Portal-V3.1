import { randomBytes, randomUUID } from "node:crypto";
import { passwordHash } from "./passwordHash.js";
import { validatePasswordStrength } from "./passwordPolicy.js";
import { userAccessTransaction } from "./userAccessStore.js";

export async function recoverAdministratorPassword(pool, { email, password }) {
  if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    throw new Error("A valid administrator email is required");
  }
  const error = validatePasswordStrength(password);
  if (error) throw new Error(error);
  const salt = randomBytes(16);
  const hash = await passwordHash(password, salt);
  await userAccessTransaction(pool, async (client) => {
    const result = await client.query(`
      UPDATE portal_access_v1.user_credentials AS c
      SET password_salt = $2, password_hash = $3, session_version = $4,
          must_change = true, failed_attempts = 0, locked_until = 0
      FROM portal_access_v1.users AS u
      WHERE c.user_id = u.id AND u.role_name = 'Admin' AND lower(u.email) = lower($1)
      RETURNING c.user_id
    `, [email.trim(), salt, hash, randomUUID()]);
    if (result.rowCount !== 1) throw new Error("Administrator account with credentials not found");
  });
}
