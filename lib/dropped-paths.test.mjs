import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./dropped-paths.ts");
}

function withWindow(value, callback) {
  const previous = globalThis.window;
  globalThis.window = value;
  try {
    return callback();
  } finally {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  }
}

test("buildNativePathDropPayload formats native Tauri absolute paths", async () => {
  const { buildNativePathDropPayload } = await loadSubject();
  const payload = buildNativePathDropPayload(["/work/a file.ts", "/work/src", "/work/a file.ts"]);

  assert.equal(payload.imageFiles.length, 0);
  assert.equal(payload.hasNonImageFiles, true);
  assert.equal(payload.pathMentions, '@"/work/a file.ts" @"/work/src" ');
});

test("buildDropPayload uses file URLs when browser paths are unavailable", async () => {
  const { buildDropPayload } = await loadSubject();
  withWindow({}, () => {
    const payload = buildDropPayload({
      files: [{ type: "text/plain", name: "ignored.txt" }],
      getData: (type) => type === "text/uri-list"
        ? "# Finder\nfile:///Users/a%20b/project/readme.md\nhttps://example.test/nope"
        : "",
    });

    assert.equal(payload.pathMentions, '@"/Users/a b/project/readme.md" ');
  });
});

test("buildDropPayload removes duplicate and malformed paths", async () => {
  const { buildDropPayload } = await loadSubject();
  withWindow({}, () => {
    const payload = buildDropPayload({
      files: [{ type: "text/plain", name: "unknown.txt" }],
      getData: () => "file:///tmp/a.ts\nfile:///tmp/a.ts\nfile://%zz",
    });

    assert.equal(payload.pathMentions, '@"/tmp/a.ts" ');
    assert.equal(payload.hasNonImageFiles, true);
  });
});

test("buildDropPayload identifies an unresolvable non-image drop without touching images", async () => {
  const { buildDropPayload } = await loadSubject();
  withWindow({}, () => {
    const payload = buildDropPayload({
      files: [{ type: "application/pdf", name: "outside.pdf" }],
      getData: () => "",
    });

    assert.equal(payload.imageFiles.length, 0);
    assert.equal(payload.hasNonImageFiles, true);
    assert.equal(payload.pathMentions, "");
  });
});
