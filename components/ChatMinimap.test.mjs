import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

registerHooks({
  load(url, context, nextLoad) {
    if (!url.endsWith(".module.css")) return nextLoad(url, context);
    return {
      format: "module",
      shortCircuit: true,
      source: "export default new Proxy({}, { get: (_, key) => String(key) });",
    };
  },
});

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const {
  AssistantOutline,
  MINIMAP_PINNED_STORAGE_KEY,
  shouldKeepPreviewOpen,
  getPinnedStateFromStorage,
} = await jiti.import("./ChatMinimap.tsx");

test("preview open state stays true when pinned", () => {
  assert.equal(shouldKeepPreviewOpen({ isPinned: true, minimapHovered: false }), true);
  assert.equal(shouldKeepPreviewOpen({ isPinned: true, minimapHovered: true }), true);
  assert.equal(shouldKeepPreviewOpen({ isPinned: false, minimapHovered: true }), true);
  assert.equal(shouldKeepPreviewOpen({ isPinned: false, minimapHovered: false }), false);
});

test("reads pinned state from localStorage value safely", () => {
  assert.equal(MINIMAP_PINNED_STORAGE_KEY, "pi-chat-minimap-pinned");
  assert.equal(getPinnedStateFromStorage("1"), true);
  assert.equal(getPinnedStateFromStorage("0"), false);
  assert.equal(getPinnedStateFromStorage(null), false);
  assert.equal(getPinnedStateFromStorage("true"), false);
});

test("renders math in headings without disabling heading navigation", () => {
  const html = renderToStaticMarkup(
    React.createElement(AssistantOutline, {
      markdown: String.raw`# Inline $f_{k,t+1}$

## Parentheses \(x^2 + y^2\)`,
      onHeadingClick() {},
    }),
  );

  assert.match(html, /class="katex"/);
  assert.match(html, /data-preview-heading-index="0"/);
  assert.match(html, /data-preview-heading-index="1"/);
  assert.doesNotMatch(html, /disabled=""/);
});
