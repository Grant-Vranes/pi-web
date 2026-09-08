import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { buildProxyDispatcher } = await createJiti(import.meta.url).import("./proxy-connection.ts");

function hasClose(dispatch) {
  return dispatch !== null && typeof dispatch.close === "function";
}

test("buildProxyDispatcher returns null when the proxy is incomplete or has no host/port", () => {
  assert.equal(buildProxyDispatcher({ protocol: "http", host: "", port: 0 }), null);
  assert.equal(buildProxyDispatcher({ protocol: "http", host: "h", port: 0 }), null);
  assert.equal(buildProxyDispatcher({ protocol: "http", host: "h", port: 99999 }), null);
});

test("buildProxyDispatcher builds an HTTP dispatcher (with optional auth)", () => {
  const dispatch = buildProxyDispatcher({ protocol: "http", host: "127.0.0.1", port: 8080 });
  assert.ok(dispatch, "HTTP dispatcher should be built");
  assert.equal(typeof dispatch.dispatch, "function", "must be a full Dispatcher");
  assert.ok(hasClose(dispatch), "dispatcher should expose close");
});

test("buildProxyDispatcher builds a SOCKS5 dispatcher via the socks5:// scheme undici accepts", () => {
  const dispatch = buildProxyDispatcher({ protocol: "socks5", host: "127.0.0.1", port: 1080, username: "u", password: "p" });
  assert.ok(dispatch, "SOCKS5 dispatcher should be built");
  // Constructor must not throw (accepts socks5://, rejects socks5h://).
  assert.ok(hasClose(dispatch));
});