// Source-level coverage for the project-wide session delete endpoint added to
// the sessions collection route. Behavioural deletion is unit-tested in
// lib/project-session-delete.test.mjs; here we assert the route reads
// ?projectRoot and maps each helper result to its HTTP status.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const routeSrc = readFileSync(new URL("./route.ts", import.meta.url), "utf8");

test("collection route exposes a DELETE handler that delegates to deleteSessionsForProject", () => {
  assert.match(routeSrc, /export async function DELETE/);
  assert.match(routeSrc, /deleteSessionsForProject/);
  assert.match(routeSrc, /searchParams\.get\("projectRoot"\)/);
});

test("DELETE handler rejects a missing projectRoot", () => {
  assert.match(routeSrc, /missing-project-root/);
  assert.match(routeSrc, /status: 400/);
});

test("DELETE handler maps blocked-running to 409", () => {
  assert.match(routeSrc, /blocked-running/);
  assert.match(routeSrc, /status: 409/);
});

test("DELETE handler maps not-found to 404 and success to ok", () => {
  assert.match(routeSrc, /not-found/);
  assert.match(routeSrc, /status: 404/);
  assert.match(routeSrc, /ok: true, deleted/);
});
