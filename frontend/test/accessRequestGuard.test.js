import assert from "node:assert/strict";
import test from "node:test";
import { createAccessRequestGuard } from "../src/lib/accessRequestGuard.js";

test("access refresh ignores older responses, identity changes and logout", () => {
  let identity = "user:role";
  const guard = createAccessRequestGuard(() => identity);
  const first = guard.begin();
  const second = guard.begin();
  assert.equal(first(), false);
  assert.equal(second(), true);
  identity = "user:other-role";
  assert.equal(second(), false);
  const third = guard.begin();
  assert.equal(third(), true);
  guard.invalidate();
  assert.equal(third(), false);
});
