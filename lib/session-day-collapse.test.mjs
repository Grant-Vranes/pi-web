import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { loadCollapsedDayGroups, saveCollapsedDayGroups, hasCollapseBeenSeeded, markCollapseSeeded } = await jiti.import("./session-day-collapse.ts");

function createStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
    removeItem(key) {
      values.delete(key);
    },
  };
}

test("defaults to no collapsed groups", () => {
  assert.deepEqual([...loadCollapsedDayGroups(createStorage())], []);
});

test("saves and restores collapsed date keys", () => {
  const storage = createStorage();
  const collapsed = new Set(["2025-01-15", "2025-01-10"]);

  saveCollapsedDayGroups(collapsed, storage);
  assert.deepEqual([...loadCollapsedDayGroups(storage)].sort(), ["2025-01-10", "2025-01-15"]);
});

test("persists an empty array (not removed) so manual expand survives reload", () => {
  const storage = createStorage({ "pi-web:session-day-collapse": "[\"2025-01-15\"]" });

  saveCollapsedDayGroups(new Set(), storage);
  // Still stored as "[]" to distinguish from never-initialized
  assert.equal(storage.values.get("pi-web:session-day-collapse"), "[]");
  assert.deepEqual([...loadCollapsedDayGroups(storage)], []);
});

test("ignores malformed JSON", () => {
  const storage = createStorage({ "pi-web:session-day-collapse": "not-json" });
  assert.deepEqual([...loadCollapsedDayGroups(storage)], []);
});

test("ignores non-array payloads", () => {
  const storage = createStorage({ "pi-web:session-day-collapse": "{\"2025-01-15\":true}" });
  assert.deepEqual([...loadCollapsedDayGroups(storage)], []);
});

test("falls back to empty when browser storage is unavailable", () => {
  const unavailable = {
    getItem() { throw new Error("blocked"); },
    setItem() { throw new Error("blocked"); },
    removeItem() { throw new Error("blocked"); },
  };

  assert.deepEqual([...loadCollapsedDayGroups(unavailable)], []);
  assert.doesNotThrow(() => saveCollapsedDayGroups(new Set(["2025-01-15"]), unavailable));
});

test("hasCollapseBeenSeeded defaults to false and flips after marking", () => {
  const storage = createStorage();
  assert.equal(hasCollapseBeenSeeded(storage), false);
  markCollapseSeeded(storage);
  assert.equal(hasCollapseBeenSeeded(storage), true);
});

test("seeded helpers tolerate unavailable storage", () => {
  const unavailable = {
    getItem() { throw new Error("blocked"); },
    setItem() { throw new Error("blocked"); },
    removeItem() { throw new Error("blocked"); },
  };
  assert.equal(hasCollapseBeenSeeded(unavailable), false);
  assert.doesNotThrow(() => markCollapseSeeded(unavailable));
});
