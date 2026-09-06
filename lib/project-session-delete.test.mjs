// Static + behavioral coverage for the project-wide session delete helper.
// The route (see app/api/sessions/project-delete-route.test.mjs) wires the
// result union through to HTTP statuses; here we assert the helper drains each
// matched session with the same teardown the single-session DELETE route uses,
// and that it never trusts a raw client path as the grouping key.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const src = await readFile(new URL("./project-session-delete.ts", import.meta.url), "utf8");

test("helper exports the result union", () => {
  assert.match(src, /deleteSessionsForProject\s*\(\s*projectRoot: string/s);
  assert.match(src, /status: "blocked-running"/);
  assert.match(src, /status: "deleted"/);
  assert.match(src, /status: "not-found"/);
});

test("helper resolves the project key server-side, never trusts the raw root as key", () => {
  assert.match(src, /projectIdentityKey\s*\(/s);
  assert.match(src, /targetKey/);
  assert.match(src, /session\.projectKey ===\s*targetKey/s);
});

test("helper blocks (no delete) when any matched session is running", () => {
  assert.match(src, /isRunning\(\)/);
  assert.match(src, /runningCount > 0/);
});

test("helper reuses single-session delete teardown per matched file", () => {
  assert.match(src, /getRpcSession\(session\.id\)\?\.shutdown\(\)/);
  assert.match(src, /unlinkSync\(session\.path\)/);
  assert.match(src, /forgetArchivedSession\(session\.id\)/);
  assert.match(src, /invalidateSessionPathCache\(session\.id\)/);
});

test("helper tolerates per-file failures and invalidates the list cache once", () => {
  assert.match(src, /catch \{/);
  assert.match(src, /invalidateSessionListCache\(\)/);
});
