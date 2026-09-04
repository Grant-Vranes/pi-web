import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveInitialBaseMtimeMs,
  resolveInitialDraft,
  resolveInitialFileDisplayMode,
} from "./file-viewer-state.ts";

test("a restored display mode wins over a stale open hint", () => {
  const state = {
    displayMode: "source",
    wrapLines: true,
    scrollTop: 80,
    scrollLeft: 0,
  };

  assert.equal(resolveInitialFileDisplayMode(state, "diff"), "source");
});

test("the open hint is used only before viewer state has been saved", () => {
  assert.equal(resolveInitialFileDisplayMode(undefined, "diff"), "diff");
  assert.equal(resolveInitialFileDisplayMode(), "source");
});

test("initial draft and base mtime restore only well-formed values", () => {
  const state = { displayMode: "source", wrapLines: false, scrollTop: 0, scrollLeft: 0, draft: "partial edit", baseMtimeMs: 1234.5 };
  assert.equal(resolveInitialDraft(state), "partial edit");
  assert.equal(resolveInitialBaseMtimeMs(state), 1234.5);

  const withoutDraft = { displayMode: "source", wrapLines: false, scrollTop: 0, scrollLeft: 0, draft: null, baseMtimeMs: "x" };
  assert.equal(resolveInitialDraft(withoutDraft), null);
  assert.equal(resolveInitialBaseMtimeMs(withoutDraft), null);
  assert.equal(resolveInitialDraft(undefined), null);
  assert.equal(resolveInitialBaseMtimeMs(undefined), null);
});
