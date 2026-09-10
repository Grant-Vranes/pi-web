import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./FileIcons.tsx", import.meta.url), "utf8");

test("maps .excalidraw files to a dedicated icon", () => {
  assert.match(source, /function ExcalidrawIcon\(/);
  assert.match(source, /excalidraw.*ExcalidrawIcon|ExcalidrawIcon.*excalidraw/s);
});

test("excalidraw keys exist in every locale", async () => {
  for (const locale of ["en", "zh-CN", "zh-TW"]) {
    const messages = await readFile(new URL(`../lib/i18n/messages/${locale}.ts`, import.meta.url), "utf8");
    assert.match(messages, /"i18n\.openAsText"/, locale);
    assert.match(messages, /"i18n\.invalidExcalidrawScene"/, locale);
  }
});
