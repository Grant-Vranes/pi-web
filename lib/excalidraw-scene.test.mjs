import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./excalidraw-scene.ts");
}

function fakeResponse(chunk) {
  return {
    async json() {
      return chunk;
    },
  };
}

test("fetchSceneText concatenates multi-chunk scene content and returns read metadata", async () => {
  const { fetchSceneText } = await loadSubject();
  const calls = [];
  const chunks = [
    { content: '{"elements":', nextOffset: 12, truncated: true, size: 30, mtimeMs: 100 },
    { content: "[],", nextOffset: 15, truncated: true, size: 30, mtimeMs: 100 },
    { content: '"appState":{}}', nextOffset: 30, truncated: false, size: 30, mtimeMs: 100 },
  ];

  const result = await fetchSceneText(
    async (url) => {
      calls.push(url);
      return fakeResponse(chunks.shift());
    },
    (offset) => (offset === undefined ? "/read" : `/read?offset=${offset}`),
  );

  assert.deepEqual(result, { text: '{"elements":[],"appState":{}}', size: 30, mtimeMs: 100 });
  assert.deepEqual(calls, ["/read", "/read?offset=12", "/read?offset=15"]);
});

test("fetchSceneText returns a single untruncated chunk with read metadata", async () => {
  const { fetchSceneText } = await loadSubject();
  const calls = [];

  const result = await fetchSceneText(
    async (url) => {
      calls.push(url);
      return fakeResponse({ content: "single", truncated: false, size: 6, mtimeMs: 200 });
    },
    (offset) => (offset === undefined ? "/read" : `/read?offset=${offset}`),
  );

  assert.deepEqual(result, { text: "single", size: 6, mtimeMs: 200 });
  assert.deepEqual(calls, ["/read"]);
});

test("fetchSceneText restarts when chunk metadata changes mid-read", async () => {
  const { fetchSceneText } = await loadSubject();
  const calls = [];
  const chunks = [
    { content: "old-", nextOffset: 4, truncated: true, size: 10, mtimeMs: 1 },
    { content: "version", nextOffset: 11, truncated: false, size: 11, mtimeMs: 2 },
    { content: "new-", nextOffset: 4, truncated: true, size: 12, mtimeMs: 3 },
    { content: "scene", nextOffset: 9, truncated: false, size: 12, mtimeMs: 3 },
  ];

  const result = await fetchSceneText(
    async (url) => {
      calls.push(url);
      return fakeResponse(chunks.shift());
    },
    (offset) => (offset === undefined ? "/read" : `/read?offset=${offset}`),
  );

  assert.deepEqual(result, { text: "new-scene", size: 12, mtimeMs: 3 });
  assert.deepEqual(calls, ["/read", "/read?offset=4", "/read", "/read?offset=4"]);
});

test("fetchSceneText throws when a chunk carries an error field", async () => {
  const { fetchSceneText } = await loadSubject();

  await assert.rejects(
    fetchSceneText(
      async () => fakeResponse({ error: "read failed", truncated: false }),
      () => "/read",
    ),
    /read failed/,
  );
});

test("buildMergedScene preserves unknown top-level keys and whitelists appState", async () => {
  const { buildMergedScene } = await loadSubject();
  const original = {
    type: "custom-type",
    version: 99,
    source: "other-tool",
    custom: { keep: true },
    elements: [{ id: "old" }],
    appState: { viewBackgroundColor: "#000", scrollX: 100 },
    files: { oldFile: { id: "oldFile" } },
  };
  const elements = [{ id: "new" }];
  const files = { newFile: { id: "newFile" } };

  const merged = buildMergedScene(
    original,
    elements,
    {
      viewBackgroundColor: "#fff",
      gridSize: 20,
      gridModeEnabled: true,
      scrollX: 200,
      collaborators: [],
    },
    files,
  );

  assert.equal(merged.type, "custom-type");
  assert.equal(merged.version, 99);
  assert.deepEqual(merged.custom, { keep: true });
  assert.deepEqual(merged.elements, elements);
  assert.deepEqual(merged.files, files);
  assert.deepEqual(merged.appState, {
    viewBackgroundColor: "#fff",
    gridSize: 20,
    gridModeEnabled: true,
  });
});
