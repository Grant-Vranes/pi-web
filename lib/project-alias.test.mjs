import assert from "node:assert/strict";
import { test } from "node:test";
import {
  loadProjectAliases,
  projectDisplayName,
  projectFolderName,
  setProjectAlias,
} from "./project-alias.ts";

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

test("projectFolderName derives the fallback name from the root", () => {
  assert.equal(projectFolderName("/home/u/pi-web"), "pi-web");
  assert.equal(projectFolderName("C:\\dev\\my-app\\"), "my-app");
  assert.equal(projectFolderName("/"), "/");
});

test("projectDisplayName prefers a non-empty alias, else the folder name", () => {
  assert.equal(projectDisplayName("/home/u/pi-web", "My Project"), "My Project");
  assert.equal(projectDisplayName("/home/u/pi-web", "  "), "pi-web");
  assert.equal(projectDisplayName("/home/u/pi-web", undefined), "pi-web");
});

test("setProjectAlias stores and clears per workspace key", () => {
  const storage = memoryStorage();
  setProjectAlias("k1", "Alpha", storage);
  setProjectAlias("k2", "Beta", storage);
  assert.deepEqual(loadProjectAliases(storage), { k1: "Alpha", k2: "Beta" });

  // Re-setting replaces; blank clears the entry but keeps the others.
  setProjectAlias("k1", "Gamma", storage);
  setProjectAlias("k2", "  ", storage);
  assert.deepEqual(loadProjectAliases(storage), { k1: "Gamma" });

  // Clearing the last entry removes the storage item entirely.
  setProjectAlias("k1", "", storage);
  assert.deepEqual(loadProjectAliases(storage), {});
  assert.equal(storage.getItem("pi-web:project-aliases"), null);
});

test("loadProjectAliases tolerates corrupt or malformed storage", () => {
  const corrupt = memoryStorage();
  corrupt.setItem("pi-web:project-aliases", "{not json");
  assert.deepEqual(loadProjectAliases(corrupt), {});

  const malformed = memoryStorage();
  malformed.setItem("pi-web:project-aliases", JSON.stringify({ a: 1, b: "ok", c: null, d: "  x  " }));
  assert.deepEqual(loadProjectAliases(malformed), { b: "ok", d: "x" });
});
