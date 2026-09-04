import assert from "node:assert/strict";
import test from "node:test";

import { findMatches, replaceAll, replaceOne } from "./file-search.ts";

test("findMatches locates plain-text matches with 1-based line numbers", () => {
  const content = "alpha\nbeta\ngamma beta";
  assert.deepEqual(findMatches(content, "beta", true), [
    { line: 2, start: 6, end: 10 },
    { line: 3, start: 17, end: 21 },
  ]);
});

test("empty query yields no matches", () => {
  assert.deepEqual(findMatches("anything", "", true), []);
  assert.deepEqual(findMatches("", "x", true), []);
});

test("case-insensitive matching folds ASCII case only", () => {
  const content = "Foo FOO fö";
  assert.deepEqual(
    findMatches(content, "foo", false).map((m) => [m.start, m.end]),
    [[0, 3], [4, 7]],
  );
  assert.deepEqual(findMatches(content, "foo", true), []);
  assert.deepEqual(findMatches("Foo fOO foo", "foo", true), [{ line: 1, start: 8, end: 11 }]);
});

test("matches never overlap", () => {
  assert.deepEqual(findMatches("aaaa", "aa", true), [
    { line: 1, start: 0, end: 2 },
    { line: 1, start: 2, end: 4 },
  ]);
});

test("replaceOne splices a single match", () => {
  const content = "alpha beta gamma";
  const match = findMatches(content, "beta", true)[0];
  assert.equal(replaceOne(content, match, "B"), "alpha B gamma");
});

test("replaceAll replaces every match and reports the count", () => {
  const content = "aXbXc";
  const matches = findMatches(content, "X", true);
  assert.deepEqual(replaceAll(content, matches, "YY"), { content: "aYYbYYc", count: 2 });
  assert.deepEqual(replaceAll(content, [], "YY"), { content, count: 0 });
});

test("replacement containing the query does not loop or corrupt", () => {
  const content = "a b a";
  const matches = findMatches(content, "a", true);
  const result = replaceAll(content, matches, "a");
  assert.equal(result.content, "a b a");
});
