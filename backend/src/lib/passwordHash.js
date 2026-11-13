import { scrypt } from "node:crypto";
import { promisify } from "node:util";

const derive = promisify(scrypt);

export function passwordHash(password, salt) {
  return derive(password, salt, 64, { N: 16384, r: 8, p: 1 });
}
