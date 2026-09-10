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

test("fetchSceneText concatenates multi-chunk scene content", async () => {
  const { fetchSceneText } = await loadSubject();
  const calls = [];
  const chunks = [
    { content: '{"elements":', nextOffset: 12, truncated: true },
    { content: "[],", nextOffset: 15, truncated: true },
    { content: '"appState":{}}', nextOffset: 30, truncated: false },
  ];

  const text = await fetchSceneText(
    async (url) => {
      calls.push(url);
      return fakeResponse(chunks.shift());
    },
    (offset) => (offset === undefined ? "/read" : `/read?offset=${offset}`),
  );

  assert.equal(text, '{"elements":[],"appState":{}}');
  assert.deepEqual(calls, ["/read", "/read?offset=12", "/read?offset=15"]);
});

test("fetchSceneText returns a single untruncated chunk", async () => {
  const { fetchSceneText } = await loadSubject();
  const calls = [];

  const text = await fetchSceneText(
    async (url) => {
      calls.push(url);
      return fakeResponse({ content: "single", truncated: false });
    },
    (offset) => (offset === undefined ? "/read" : `/read?offset=${offset}`),
  );

  assert.equal(text, "single");
  assert.deepEqual(calls, ["/read"]);
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
