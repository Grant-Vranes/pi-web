import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { cleanDist, isRetriableRemoveError } = require("./clean-dist.cjs");

test("isRetriableRemoveError matches filesystem race errors", () => {
  assert.equal(isRetriableRemoveError({ code: "ENOTEMPTY" }), true);
  assert.equal(isRetriableRemoveError({ code: "EBUSY" }), true);
  assert.equal(isRetriableRemoveError({ code: "EPERM" }), true);
  assert.equal(isRetriableRemoveError({ code: "EACCES" }), false);
});

test("cleanDist retries retriable failures then succeeds", () => {
  let attempts = 0;
  const fsStub = {
    rmSync() {
      attempts += 1;
      if (attempts < 3) {
        const error = new Error("busy");
        error.code = "ENOTEMPTY";
        throw error;
      }
    },
  };

  const waits = [];
  cleanDist({
    targetDir: "dist",
    attempts: 5,
    fsModule: fsStub,
    wait: (ms) => waits.push(ms),
  });

  assert.equal(attempts, 3);
  assert.deepEqual(waits, [200, 400]);
});

test("cleanDist throws immediately on non-retriable failures", () => {
  const fsStub = {
    rmSync() {
      const error = new Error("permission denied");
      error.code = "EACCES";
      throw error;
    },
  };

  assert.throws(
    () => cleanDist({ targetDir: "dist", attempts: 5, fsModule: fsStub, wait: () => {} }),
    /Failed to remove "dist" after 5 attempts \(EACCES\)/,
  );
});

test("cleanDist surfaces a helpful error after retries are exhausted", () => {
  let attempts = 0;
  const fsStub = {
    rmSync() {
      attempts += 1;
      const error = new Error("directory not empty");
      error.code = "ENOTEMPTY";
      throw error;
    },
  };

  assert.throws(
    () => cleanDist({ targetDir: "dist", attempts: 3, fsModule: fsStub, wait: () => {} }),
    /Failed to remove "dist" after 3 attempts/,
  );
  assert.equal(attempts, 3);
});
