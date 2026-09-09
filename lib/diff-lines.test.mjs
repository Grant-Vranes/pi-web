import assert from "node:assert/strict";
import test from "node:test";

import { diffLinesBetween } from "./diff-lines.ts";

function kinds(changed) {
  return Object.fromEntries([...changed.entries()].map(([k, v]) => [k, v]));
}

test("no changes yields an empty change map", () => {
  const text = "a\nb\nc";
  const r = diffLinesBetween(text, text);
  assert.equal(r.changed.size, 0);
  assert.equal(r.added, 0);
  assert.equal(r.modified, 0);
});

test("modifying a single line marks it modified", () => {
  const r = diffLinesBetween("const x = 1;\nconst y = 2;\n", "const x = 1;\nconst y = 999;\n");
  assert.deepEqual(kinds(r.changed), { 1: "modified" });
  assert.equal(r.added, 0);
  assert.equal(r.modified, 1);
});

test("inserting a line marks only the inserted line added", () => {
  const r = diffLinesBetween("a\nb\nd\n", "a\nbb\nb\nd\n");
  assert.deepEqual(kinds(r.changed), { 1: "added" });
});

test("lines after an inserted line stay unchanged", () => {
  const r = diffLinesBetween("line one\nline two\nline three\n", "line one\ninserted\nline two\nline three\n");
  assert.deepEqual(kinds(r.changed), { 1: "added" });
});

test("removed lines produce no markers and remaining lines stay aligned", () => {
  const r = diffLinesBetween("w\nx\ny\nz\n", "w\ny\nz\n");
  assert.equal(r.changed.size, 0, "deleting a line leaves no current-line markers");
});

test("replacing a line with a similar one is modified, a brand-new one is added", () => {
  const original = "foo(a);\nclose(handle);\n";
  const replace = diffLinesBetween(original, "foo(b);\nclose(handle);\n");
  assert.deepEqual(kinds(replace.changed), { 0: "modified" });

  const insert = diffLinesBetween(original, "brand new line entirely\nfoo(b);\nclose(handle);\n");
  assert.deepEqual(kinds(insert.changed), { 0: "added", 1: "modified" });
});

test("empty baseline marks every current line as added", () => {
  const r = diffLinesBetween("", "x\ny\n");
  assert.deepEqual(kinds(r.changed), { 0: "added", 1: "added" });
  assert.equal(r.added, 2);
});

test("empty current text yields no markers", () => {
  const r = diffLinesBetween("x\ny\n", "");
  assert.equal(r.changed.size, 0);
});

test("a change deep in a large-looking file with common head/tail stays scoped", () => {
  const head = Array.from({ length: 2500 }, (_, i) => `const v${i} = ${i};`).join("\n");
  const tail = "footer\n";
  const baseline = `${head}\n${tail}`;
  const edited = `${head}\nmutated = true;\n${tail}`;
  const r = diffLinesBetween(baseline, edited);
  assert.equal(r.changed.size, 1, "only the inserted line differs");
  assert.deepEqual(kinds(r.changed), { 2500: "added" });
});

test("very large inputs still classify changed lines via the sweep fallback", () => {
  const many = 50000;
  const baseline = Array.from({ length: many }, (_, i) => `line ${i}`).join("\n");
  const parts = baseline.split("\n");
  parts[12345] = "line CHANGED";
  parts.push("appended end line");
  const r = diffLinesBetween(baseline, parts.join("\n"));
  assert.equal(r.changed.get(12345), "modified");
  assert.deepEqual(kinds(r.changed), { 12345: "modified", [many]: "added" });
});