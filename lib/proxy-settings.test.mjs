import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const {
  readProxyConfig,
  writeProxyConfig,
  clearProxyConfig,
  buildProxyUri,
} = await createJiti(import.meta.url).import("./proxy-settings.ts");

async function tempPath(t, prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return join(root, "proxy.json");
}

test("absent proxy config fails closed (disabled, empty)", async (t) => {
  const path = await tempPath(t, "pi-web-proxy-absent-");
  const config = readProxyConfig(path);
  assert.equal(config.enabled, false);
  assert.equal(config.host, "");
  assert.equal(config.port, 0);
  assert.equal(config.protocol, "http");
  assert.equal(config.password, undefined);
  assert.equal(config.testUrl, "https://api.taotoken.net/coding/v1");
  assert.deepEqual(config.noProxy, []);
  assert.equal(config.hadInvalidFields, false);
});

test("write/read roundtrip stores full config", async (t) => {
  const path = await tempPath(t, "pi-web-proxy-roundtrip-");
  writeProxyConfig({
    enabled: true,
    protocol: "socks5",
    host: "10.0.0.5",
    port: 1080,
    username: "user",
    password: "secret",
    testUrl: "https://example.test",
    noProxy: ["localhost", "10.0.0.0/8"],
  }, path);

  const config = readProxyConfig(path);
  assert.equal(config.enabled, true);
  assert.equal(config.protocol, "socks5");
  assert.equal(config.host, "10.0.0.5");
  assert.equal(config.port, 1080);
  assert.equal(config.username, "user");
  assert.equal(config.password, "secret");
  assert.equal(config.testUrl, "https://example.test");
  assert.deepEqual(config.noProxy, ["localhost", "10.0.0.0/8"]);

  const raw = JSON.parse(await readFile(path, "utf8"));
  assert.equal(raw.password, "secret");
  // Credential file must be written privately (0600).
  const mode = (await import("node:fs")).statSync(path).mode & 0o777;
  assert.equal(mode, 0o600);
});

test("omitting noProxy/testUrl keeps defaults and omits null fields", async (t) => {
  const path = await tempPath(t, "pi-web-proxy-minimal-");
  writeProxyConfig({ enabled: true, protocol: "http", host: "proxy.corp", port: 8080 }, path);
  const config = readProxyConfig(path);
  assert.equal(config.testUrl, "https://api.taotoken.net/coding/v1");
  assert.deepEqual(config.noProxy, []);
  const raw = JSON.parse(await readFile(path, "utf8"));
  assert.equal(raw.testUrl, undefined);
  assert.equal(raw.noProxy, undefined);
});

test("clearProxyConfig resets to disabled", async (t) => {
  const path = await tempPath(t, "pi-web-proxy-clear-");
  writeProxyConfig({ enabled: true, protocol: "http", host: "h", port: 80, password: "x" }, path);
  clearProxyConfig(path);
  const config = readProxyConfig(path);
  assert.equal(config.enabled, false);
  assert.equal(config.password, undefined);
});

test("malformed proxy config fails closed and does not throw", async (t) => {
  const path = await tempPath(t, "pi-web-proxy-malformed-");
  await writeFile(path, "{%GARBAGE");
  const config = readProxyConfig(path);
  assert.equal(config.enabled, false);
  assert.equal(config.host, "");
});

test("invalid protocol/port values are normalized away and flagged", async (t) => {
  const path = await tempPath(t, "pi-web-proxy-invalid-");
  writeProxyConfig({
    enabled: true,
    protocol: "banana",
    host: "h",
    port: 0,
  }, path);
  const config = readProxyConfig(path);
  assert.equal(config.protocol, "http"); // falls back
  assert.equal(config.port, 0);
  assert.equal(config.hadInvalidFields, true);
});

test("buildProxyUri encodes credentials and chooses scheme", () => {
  assert.equal(
    buildProxyUri({ protocol: "http", host: "proxy.corp", port: 8080 }),
    "http://proxy.corp:8080",
  );
  assert.equal(
    buildProxyUri({ protocol: "http", host: "proxy.corp", port: 8080, username: "u s", password: "p@ss:w" }),
    "http://u%20s:p%40ss%3Aw@proxy.corp:8080",
  );
  assert.equal(
    buildProxyUri({ protocol: "https", host: "p", port: 443, username: "u" }),
    "https://u@p:443",
  );
  assert.equal(
    buildProxyUri({ protocol: "socks5", host: "p", port: 1080 }),
    "socks5://p:1080",
  );
  // Missing/invalid host or port yields null.
  assert.equal(buildProxyUri({ protocol: "http", host: "", port: 80 }), null);
  assert.equal(buildProxyUri({ protocol: "http", host: "h", port: 0 }), null);
  assert.equal(buildProxyUri({ protocol: "http", host: "h", port: 99999 }), null);
});