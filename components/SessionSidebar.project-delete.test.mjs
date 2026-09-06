// Source-level coverage for the project-wide delete orchestration added to
// SessionSidebar: the rail card's delete action calls the batch route, drops
// the project from the persisted rail history, and delegates active-tab cleanup
// to the existing single-session delete path when the open chat is affected.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");
const deleteStart = source.indexOf("const handleDeleteProject = useCallback");
const deleteEnd = source.indexOf("const canCreateSession", deleteStart);
const deleteSource = source.slice(deleteStart, deleteEnd);

test("handleDeleteProject is defined next to rail construction", () => {
  assert.notEqual(deleteStart, -1, "handleDeleteProject callback exists");
  assert.notEqual(deleteEnd, -1);
  // It is handed to ProjectRail so the hover card can invoke it.
  assert.match(source, /onDeleteProject=\{handleDeleteProject\}/);
});

test("handleDeleteProject calls the batch route with the project root", () => {
  assert.match(deleteSource, /\/api\/sessions\?projectRoot=/);
  assert.match(deleteSource, /method: "DELETE"/);
});

test("handleDeleteProject maps the running block (409) to blocked-running", () => {
  assert.match(deleteSource, /res\.status === 409/);
  assert.match(deleteSource, /blocked-running/);
});

test("handleDeleteProject removes the project from persisted rail history", () => {
  assert.match(deleteSource, /setProjectRailHistory\(/);
  assert.match(deleteSource, /entry\.key !== project\.key/);
});

test("handleDeleteProject clears the open tab via onSessionDeleted when affected", () => {
  assert.match(deleteSource, /workspaceKeyOf\(active\) === project\.key/);
  assert.match(deleteSource, /onSessionDeleted\(selectedSessionId\)/);
  assert.match(deleteSource, /loadSessions\(false, true\)/);
});
