import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const { mutateFile, FileMutationError } = await createJiti(import.meta.url).import("./file-mutations.ts");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-mutations-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, roots: new Set([root]) };
}

test("creates files and directories only below an authorized directory", (t) => {
  const { root, roots } = fixture(t);
  const directory = path.join(root, "src");
  fs.mkdirSync(directory);
  assert.deepEqual(mutateFile({ type: "create-directory", directory, name: "nested" }, roots), {
    sourcePath: path.join(directory, "nested"),
    destinationPath: path.join(directory, "nested"),
    deleted: false,
  });
  mutateFile({ type: "create-file", directory: path.join(directory, "nested"), name: "index.ts" }, roots);
  assert.equal(fs.readFileSync(path.join(directory, "nested", "index.ts"), "utf8"), "");
});

test("rejects invalid names, conflicts, and lexical root escapes", (t) => {
  const { root, roots } = fixture(t);
  fs.writeFileSync(path.join(root, "exists.txt"), "x");
  fs.symlinkSync(path.join(root, "missing-target"), path.join(root, "dangling-link"));
  for (const name of ["", ".", "..", "a/b", "../outside"]) {
    assert.throws(() => mutateFile({ type: "create-file", directory: root, name }, roots), FileMutationError);
  }
  for (const name of ["exists.txt", "dangling-link"]) {
    assert.throws(
      () => mutateFile({ type: "create-file", directory: root, name }, roots),
      (error) => error.status === 409,
    );
  }
});

test("rejects source or destination that escapes through a symlink", (t) => {
  const { root, roots } = fixture(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-outside-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.symlinkSync(outside, path.join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(
    () => mutateFile({ type: "create-file", directory: path.join(root, "escape"), name: "x.txt" }, roots),
    (error) => error.status === 403,
  );
});

test("renames, moves, and recursively deletes directories without following directory symlinks", (t) => {
  const { root, roots } = fixture(t);
  const source = path.join(root, "source");
  const target = path.join(root, "target");
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-link-target-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.mkdirSync(source);
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(source, "a.txt"), "a");
  const renamed = path.join(root, "renamed");
  mutateFile({ type: "rename", sourcePath: source, name: "renamed" }, roots);
  mutateFile({ type: "move", sourcePath: renamed, destinationDirectory: target }, roots);
  fs.symlinkSync(outside, path.join(target, "renamed", "link"), process.platform === "win32" ? "junction" : "dir");
  mutateFile({ type: "delete", sourcePath: path.join(target, "renamed") }, roots);
  assert.equal(fs.existsSync(path.join(target, "renamed")), false);
  assert.equal(fs.existsSync(outside), true);
});
