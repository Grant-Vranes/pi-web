import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);

async function loadSubject() {
  return jiti.import("./file-api.ts");
}

test("builds file api urls with type, session and extra params", async () => {
  const { getFileApiUrl } = await loadSubject();

  const url = getFileApiUrl("/tmp/a.json", "read", "session-1", { offset: 10, v: undefined });
  assert.ok(url.startsWith("/api/files/"), `unexpected prefix: ${url}`);
  assert.ok(url.includes("type=read"), url);
  assert.ok(url.includes("sessionId=session-1"), url);
  assert.ok(url.includes("offset=10"), url);
  // Undefined param values are omitted (matches the original FileViewer helper).
  assert.ok(!url.includes("v="), url);
});

test("omits sessionId when absent", async () => {
  const { getFileApiUrl } = await loadSubject();

  const url = getFileApiUrl("/tmp/a.json", "write", null);
  assert.ok(url.startsWith("/api/files/"));
  assert.ok(url.includes("type=write"));
  assert.ok(!url.includes("sessionId="), url);
});
