import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  moduleCache: false,
});
const { openInFileBrowser } = await jiti.import("./file-browser.ts");

test("posts the path to /api/file-browser/open and resolves ok on 2xx", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let captured;
  globalThis.fetch = async (url, init) => {
    captured = { url, init };
    return new Response(null, { status: 200 });
  };

  const result = await openInFileBrowser("/tmp/project");
  assert.equal(result.ok, true);
  assert.equal(result.error, undefined);
  assert.equal(captured.url, "/api/file-browser/open");
  assert.equal(captured.init.method, "POST");
  assert.equal(captured.init.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(captured.init.body), { path: "/tmp/project" });
});

test("surfaces the server error message on non-2xx responses", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () => new Response(
    JSON.stringify({ error: "Access denied" }),
    { status: 403 },
  );

  const result = await openInFileBrowser("/etc");
  assert.deepEqual(result, { ok: false, error: "Access denied" });
});

test("falls back to the HTTP status when the error body is not JSON", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () => new Response("nope", { status: 500 });

  const result = await openInFileBrowser("/tmp/project");
  assert.deepEqual(result, { ok: false, error: "HTTP 500" });
});

test("resolves a failure instead of throwing on network errors", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () => {
    throw new TypeError("connection reset");
  };

  const result = await openInFileBrowser("/tmp/project");
  assert.equal(result.ok, false);
  assert.equal(result.error, "connection reset");
});
