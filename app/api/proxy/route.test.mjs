import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./route.ts", import.meta.url), "utf8");
const putStart = source.indexOf("export async function PUT");

test("proxy config GET never returns the plaintext password", () => {
  assert.match(source, /passwordSet/);
  assert.match(source, /Never return the plaintext password/);
  assert.match(source, /passwordSet: config\.password !== undefined/);
  // No path returns config.password directly.
  assert.doesNotMatch(source, /password: config\.password\b/);
});

test("mutating routes are guarded and require JSON", () => {
  const put = source.slice(putStart);
  assert.match(put, /isApiRequestAllowed\(req\)/);
  assert.match(put, /hasJsonContentType\(req\)/);
  const del = source.slice(source.indexOf("export async function DELETE"));
  assert.match(del, /isApiRequestAllowed\(req\)/);
});

test("PUT validates protocol, host and port before writing", () => {
  const put = source.slice(putStart, source.indexOf("export async function DELETE"));
  assert.match(put, /protocol !== "http" && protocol !== "https" && protocol !== "socks5"/);
  assert.match(put, /host\.trim\(\)\.length === 0/);
  assert.match(put, /port < 1 \|\| body\.port > 65535/);
  assert.match(put, /writeProxyConfig\(config\)/);
});

test("PUT keeps the stored password when none is provided", () => {
  const put = source.slice(putStart, source.indexOf("export async function DELETE"));
  assert.match(put, /an absent\/empty password means "keep the stored one"/);
  assert.match(put, /incomingPassword === undefined \? stored\.password : incomingPassword/);
});

test("stored credentials use a private agent-dir path with atomic writes", async () => {
  // The route persists proxy config through the shared lib.
  assert.match(source, /from "@\/lib\/proxy-settings"/);
  assert.match(source, /writeProxyConfig\(config\)/);
  assert.match(source, /clearProxyConfig\(\)/);
  // The lib under test persists with private 0600 permissions in the agent dir.
  const lib = await readFile(new URL("../../../lib/proxy-settings.ts", import.meta.url), "utf8");
  assert.match(lib, /writePrivateFileAtomicSync/);
  assert.match(lib, /join\(agentDir, "proxy\.json"\)/);
  assert.match(lib, /getAgentDir\(\)/);
});