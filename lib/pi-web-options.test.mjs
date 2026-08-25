import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { parseLaunchOptions } = require("../bin/pi-web-options.js");

function withProjectEnv(contents, callback) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-options-"));
  try {
    fs.writeFileSync(path.join(cwd, ".env.local"), contents);
    return callback(cwd);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

test("opens the browser by default", () => {
  assert.deepEqual(parseLaunchOptions([], {}), {
    port: "30141",
    hostname: "127.0.0.1",
    openBrowser: true,
  });
});

test("supports the no-open CLI option", () => {
  assert.equal(parseLaunchOptions(["--no-open"], {}).openBrowser, false);
});

test("supports truthy PI_WEB_NO_OPEN values", () => {
  for (const value of ["1", "true", "TRUE", "yes", "on"]) {
    assert.equal(parseLaunchOptions([], { PI_WEB_NO_OPEN: value }).openBrowser, false);
  }
});

test("does not disable browser opening for false PI_WEB_NO_OPEN values", () => {
  for (const value of ["0", "false", "off", ""]) {
    assert.equal(parseLaunchOptions([], { PI_WEB_NO_OPEN: value }).openBrowser, true);
  }
});

test("preserves port and hostname options", () => {
  assert.deepEqual(
    parseLaunchOptions(["-p", "8080", "-H", "0.0.0.0"], {}),
    {
      port: "8080",
      hostname: "0.0.0.0",
      openBrowser: true,
    },
  );
});

test("rejects port values that could inject cmd arguments", () => {
  assert.throws(
    () => parseLaunchOptions(["-p", "30141&whoami"], {}),
    /Port must be a non-negative integer/,
  );
  assert.throws(
    () => parseLaunchOptions([], { PORT: "30141&whoami" }),
    /Port must be a non-negative integer/,
  );
});

test("loads PORT from a project-local .env.local", () => {
  withProjectEnv("PORT=43141\n", (cwd) => {
    assert.equal(parseLaunchOptions([], {}, { cwd }).port, "43141");
  });
});

test("prefers caller environment and CLI port over .env.local", () => {
  withProjectEnv("PORT=43141\n", (cwd) => {
    assert.equal(parseLaunchOptions([], { PORT: "44141" }, { cwd }).port, "44141");
    assert.equal(parseLaunchOptions(["--port", "45141"], { PORT: "44141" }, { cwd }).port, "45141");
  });
});

test("rejects an invalid port supplied by .env.local", () => {
  withProjectEnv("PORT=invalid\n", (cwd) => {
    assert.throws(() => parseLaunchOptions([], {}, { cwd }), /Port must be a non-negative integer/);
  });
});

test("supports PI_WEB_HOSTNAME without trusting the ambient system HOSTNAME", () => {
  assert.equal(
    parseLaunchOptions([], { HOSTNAME: "container-id" }).hostname,
    "127.0.0.1",
  );
  assert.equal(
    parseLaunchOptions([], { PI_WEB_HOSTNAME: "0.0.0.0" }).hostname,
    "0.0.0.0",
  );
});
