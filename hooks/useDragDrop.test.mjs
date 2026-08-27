import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./useDragDrop.ts", import.meta.url), "utf8");

test("routes classified image and local-path payloads through one drop callback", () => {
  assert.match(source, /import \{ buildDropPayload, type DropPayload \} from "@\/lib\/dropped-paths"/);
  assert.match(source, /useDragDrop\(onDrop: \(payload: DropPayload\) => void\)/);
  assert.match(source, /const payload = buildDropPayload\(e\.dataTransfer\)/);
  assert.match(source, /if \(payload\.imageFiles\.length === 0 && !payload\.hasNonImageFiles\) return/);
  assert.match(source, /counterRef\.current = 0;\s*setIsDragOver\(false\);\s*onDrop\(payload\)/);
});
