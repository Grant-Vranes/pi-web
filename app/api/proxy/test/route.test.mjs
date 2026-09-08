import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./route.ts", import.meta.url), "utf8");
const postStart = source.indexOf("export async function POST");

test("proxy test POST is guarded and requires JSON", () => {
  const post = source.slice(postStart);
  assert.match(post, /isApiRequestAllowed\(req\)/);
  assert.match(post, /hasJsonContentType\(req\)/);
});

test("proxy test accepts an unsaved config and produces a latency result", () => {
  const post = source.slice(postStart);
  assert.match(post, /normalizeProxyConfig\(body\)/);
  assert.match(post, /testProxyConnection\(normalized/);
  assert.match(post, /TEST_TIMEOUT_MS/);
  // Result carries ok/latency and no password back to the form.
  assert.match(post, /return NextResponse\.json\(result\)/);
});

test("proxy test returns structured failure rather than throwing", () => {
  const post = source.slice(postStart);
  assert.match(post, /ok: false, error:\s*error instanceof Error \? error\.message : String\(error\)/);
});