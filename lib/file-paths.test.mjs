import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { sameFilePath } = await createJiti(import.meta.url).import("./file-paths.ts");

test("Windows file paths compare without separator, case, or trailing slash differences", () => {
  assert.equal(sameFilePath("C:\\Repo\\src\\File.ts\\", "c:/repo/SRC/file.ts"), true);
});

test("POSIX file path comparison remains case-sensitive", () => {
  assert.equal(sameFilePath("/repo/src/File.ts", "/repo/src/file.ts"), false);
});
