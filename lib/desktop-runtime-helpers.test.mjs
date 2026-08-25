import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  getTrayIconSize,
  shouldLaunchEmbeddedServer,
  waitForPort,
} = require("../desktop/runtime-helpers.cjs");

test("uses compact tray icon size per platform", () => {
  assert.deepEqual(getTrayIconSize("darwin"), { width: 18, height: 18 });
  assert.deepEqual(getTrayIconSize("win32"), { width: 16, height: 16 });
  assert.deepEqual(getTrayIconSize("linux"), { width: 16, height: 16 });
});

test("rejects when a port does not become reachable before the timeout", async () => {
  await assert.rejects(
    waitForPort("127.0.0.1", 1, 20),
    /Timed out waiting for 127\.0\.0\.1:1/,
  );
});

test("skips embedded server when an external dev server is expected", () => {
  assert.equal(shouldLaunchEmbeddedServer({ externalDevServer: true, portAlreadyInUse: false }), false);
});

test("skips embedded server when target port is already in use", () => {
  assert.equal(shouldLaunchEmbeddedServer({ externalDevServer: false, portAlreadyInUse: true }), false);
});

test("launches embedded server only when needed", () => {
  assert.equal(shouldLaunchEmbeddedServer({ externalDevServer: false, portAlreadyInUse: false }), true);
});
