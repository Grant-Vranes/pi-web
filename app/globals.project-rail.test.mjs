import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./globals.css", import.meta.url), "utf8");

test("project rail items use quiet borderless cards and a refined active state", () => {
  assert.match(
    source,
    /\.project-rail-item,\s*\.project-rail-add\s*\{[\s\S]*?border: 1px solid transparent;[\s\S]*?border-radius: 10px;[\s\S]*?background: color-mix\(in srgb, var\(--bg-hover\) 58%, var\(--bg-panel\)\);/,
  );
  assert.match(
    source,
    /\.project-rail-item:hover\s*\{[\s\S]*?border-color: transparent;[\s\S]*?background: color-mix\(in srgb, var\(--accent\) 6%, var\(--bg-hover\)\);/,
  );
  assert.match(
    source,
    /\.project-rail-item\.is-active\s*\{[\s\S]*?background: color-mix\(in srgb, var\(--accent\) 12%, var\(--bg-selected\)\);[\s\S]*?border-color: transparent;[\s\S]*?box-shadow: 0 2px 8px color-mix\(in srgb, var\(--accent\) 16%, transparent\);/,
  );
});

test("project card activity and drag state selectors remain available", () => {
  assert.match(source, /\.project-rail-item\.is-dragging\s*\{/);
  assert.match(source, /\.project-rail-item\.is-drop-before::before,/);
  assert.match(source, /\.project-rail-item\.is-drop-after::before\s*\{/);
  assert.match(
    source,
    /\.project-rail-running,\s*\.project-rail-unread\s*\{[\s\S]*?right: -2px;[\s\S]*?bottom: -2px;/,
  );
});
