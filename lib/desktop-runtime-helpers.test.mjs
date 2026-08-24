import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  getTrayIconSize,
  shouldLaunchEmbeddedServer,
} = require("../desktop/runtime-helpers.cjs");

test("uses compact tray icon size per platform", () => {
  assert.deepEqual(getTrayIconSize("darwin"), { width: 18, height: 18 });
  assert.deepEqual(getTrayIconSize("win32"), { width: 16, height: 16 });
  assert.deepEqual(getTrayIconSize("linux"), { width: 16, height: 16 });
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
