import assert from "node:assert/strict";
import test from "node:test";

import { getEditorLanguage } from "./codemirror-languages.ts";

test("getEditorLanguage maps common languages to a CodeMirror support extension", () => {
  for (const language of [
    "typescript",
    "javascript",
    "python",
    "go",
    "rust",
    "java",
    "c",
    "cpp",
    "html",
    "css",
    "json",
    "yaml",
    "markdown",
    "sql",
    "xml",
    "bash",
    "toml",
  ]) {
    assert.ok(getEditorLanguage(language), `${language} should resolve`);
  }
});

test("getEditorLanguage wraps legacy modes for ruby, swift, csharp, kotlin", () => {
  for (const language of ["ruby", "swift", "csharp", "kotlin"]) {
    assert.ok(getEditorLanguage(language), `${language} should resolve`);
  }
});

test("getEditorLanguage falls back to no highlighting for unsupported languages", () => {
  for (const language of ["text", "graphql", "hcl", "pdf", "word", "unknown"]) {
    assert.equal(getEditorLanguage(language), null, `${language} should be null`);
  }
});