import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");

test("partitions dropped images and path mentions without uploading path items", () => {
  assert.match(source, /const onDrop = useCallback\(\(\{ imageFiles, pathMentions, hasNonImageFiles \}: DropPayload\) => \{/);
  assert.match(source, /if \(imageFiles\.length > 0\) chatInputRef\?\.current\?\.addImages\(imageFiles\);/);
  assert.match(source, /if \(pathMentions\) \{\s*chatInputRef\?\.current\?\.insertPathMentions\(pathMentions\);\s*return;\s*}/);
  assert.match(source, /if \(hasNonImageFiles\) addNotice\(\{ type: "warning", message: "Could not access the dropped item's local path in this browser" \}\);/);
});

test("uses a generic path-or-image drop affordance", () => {
  assert.match(source, /Drop files, folders, or images to add them to your message/);
});
