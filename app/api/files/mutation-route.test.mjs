import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./[...path]/route.ts", import.meta.url), "utf8");

test("mutation requests are guarded and delegated to the canonical mutation service", () => {
  assert.match(source, /const FILE_MUTATION_TYPES = \["create-file", "create-directory", "rename", "move", "delete", "write"\] as const/);
  assert.match(source, /if \(!isApiRequestAllowed\(request\)\)/);
  assert.match(source, /const allowedRoots = await getAllowedFileRoots\(\)/);
  assert.match(source, /mutateFile\(mutation, allowedRoots\)/);
  assert.match(source, /error instanceof FileMutationError/);
});
