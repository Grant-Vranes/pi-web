import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { POST, GET } = await jiti.import("./[...path]/route.ts");
const { NextRequest } = await jiti.import("next/server");
const { allowFileRoot } = await jiti.import("@/lib/file-access");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-files-write-route-"));
  allowFileRoot(root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function postWrite(filePath, body) {
  const segments = filePath.split("/").filter(Boolean).map(encodeURIComponent);
  const url = `http://localhost/api/files/${segments.join("/")}?type=write`;
  return new NextRequest(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Host: "localhost" },
    body: JSON.stringify(body),
  });
}

function routeContext(filePath) {
  return { params: Promise.resolve({ path: filePath.split("/").filter(Boolean) }) };
}

test("write saves content and reports the new mtime", async (t) => {
  const root = fixture(t);
  const target = path.join(root, "a.md");
  fs.writeFileSync(target, "old");

  const response = await POST(postWrite(target, { content: "fresh\n", baseMtimeMs: null }), routeContext(target));
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(fs.readFileSync(target, "utf8"), "fresh\n");
  assert.equal(payload.size, 6);
  assert.equal(typeof payload.mtimeMs, "number");
});

test("write returns 409 when the disk mtime moved after the client read", async (t) => {
  const root = fixture(t);
  const target = path.join(root, "conflict.txt");
  fs.writeFileSync(target, "one");
  const baseMtimeMs = fs.statSync(target).mtimeMs;
  const later = new Date(Date.now() + 60_000);
  fs.utimesSync(target, later, later);

  const response = await POST(postWrite(target, { content: "two", baseMtimeMs }), routeContext(target));
  assert.equal(response.status, 409);
  assert.equal(fs.readFileSync(target, "utf8"), "one");
});

test("write validates the payload and target", async (t) => {
  const root = fixture(t);
  const target = path.join(root, "b.txt");
  fs.writeFileSync(target, "");

  const invalidContent = await POST(postWrite(target, { content: 5, baseMtimeMs: null }), routeContext(target));
  assert.equal(invalidContent.status, 400);

  const invalidMtime = await POST(postWrite(target, { content: "x", baseMtimeMs: "yesterday" }), routeContext(target));
  assert.equal(invalidMtime.status, 400);

  const missingPath = path.join(root, "missing.txt");
  const missing = await POST(postWrite(missingPath, { content: "x", baseMtimeMs: null }), routeContext(missingPath));
  assert.equal(missing.status, 404);
});

test("write rejects oversized bodies with 413", async (t) => {
  const root = fixture(t);
  const target = path.join(root, "big.txt");
  fs.writeFileSync(target, "");
  const big = "x".repeat(2 * 1024 * 1024);

  const response = await POST(postWrite(target, { content: big, baseMtimeMs: null }), routeContext(target));
  assert.equal(response.status, 413);
});

test("read responses include mtimeMs for conflict detection", async (t) => {
  const root = fixture(t);
  const target = path.join(root, "c.txt");
  fs.writeFileSync(target, "hello");

  const segments = target.split("/").filter(Boolean).map(encodeURIComponent);
  const request = new NextRequest(`http://localhost/api/files/${segments.join("/")}?type=read`, {
    headers: { Host: "localhost" },
  });
  const response = await GET(request, routeContext(target));
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.content, "hello");
  assert.equal(typeof payload.mtimeMs, "number");
});
