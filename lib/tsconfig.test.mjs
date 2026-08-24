import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";

const tsconfigPath = path.resolve(process.cwd(), "tsconfig.json");
const tsconfig = JSON.parse(fs.readFileSync(tsconfigPath, "utf8"));

test("tsconfig excludes build output directories from type checking", () => {
  assert.ok(Array.isArray(tsconfig.exclude), "tsconfig.exclude should be an array");
  assert.ok(tsconfig.exclude.includes("node_modules"));
  assert.ok(tsconfig.exclude.includes("dist"));
});
