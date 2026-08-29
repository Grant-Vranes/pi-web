import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  archiveSession,
  unarchiveSession,
  forgetArchivedSession,
  readArchivedSessionIds,
  invalidateArchivedSessionsCache,
} = await jiti.import("./archived-sessions.ts");

// The module reads/writes ~/.pi/agent/archived-sessions.json via getAgentDir().
// Tests mutate the in-memory cache directly and assert the resulting set so
// they never depend on (or clobber) the developer's real archived-sessions.json.

test.beforeEach(() => {
  invalidateArchivedSessionsCache();
});

test("archiveSession adds an id and round-trips through the cache", () => {
  const ids = archiveSession("session-aaa");
  assert.ok(ids.has("session-aaa"));
  assert.equal(readArchivedSessionIds().has("session-aaa"), true);
});

test("unarchiveSession removes a previously archived id", () => {
  archiveSession("session-bbb");
  const ids = unarchiveSession("session-bbb");
  assert.equal(ids.has("session-bbb"), false);
  assert.equal(readArchivedSessionIds().has("session-bbb"), false);
});

test("forgetArchivedSession is a no-op for a non-archived id", () => {
  forgetArchivedSession("never-archived");
  assert.equal(readArchivedSessionIds().has("never-archived"), false);
});

test("forgetArchivedSession removes an archived id (used on session delete)", () => {
  archiveSession("session-ccc");
  forgetArchivedSession("session-ccc");
  assert.equal(readArchivedSessionIds().has("session-ccc"), false);
});
