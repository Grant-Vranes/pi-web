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

test("reports same-path rename and move as destination conflicts", (t) => {
  const { root, roots } = fixture(t);
  const source = path.join(root, "source.txt");
  fs.writeFileSync(source, "source");

  for (const mutation of [
    { type: "rename", sourcePath: source, name: "source.txt" },
    { type: "move", sourcePath: source, destinationDirectory: root },
  ]) {
    assert.throws(
      () => mutateFile(mutation, roots),
      (error) => error instanceof FileMutationError && error.status === 409,
    );
  }
});

test("directly deletes dangling and external-target symlinks without touching their targets", (t) => {
  const { root, roots } = fixture(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-direct-link-target-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const externalFile = path.join(outside, "keep.txt");
  fs.writeFileSync(externalFile, "keep");

  const danglingLink = path.join(root, "dangling-link");
  const externalLink = path.join(root, "external-link");
  fs.symlinkSync(path.join(outside, "missing.txt"), danglingLink);
  fs.symlinkSync(externalFile, externalLink);

  mutateFile({ type: "delete", sourcePath: danglingLink }, roots);
  mutateFile({ type: "delete", sourcePath: externalLink }, roots);

  assert.throws(() => fs.lstatSync(danglingLink), { code: "ENOENT" });
  assert.throws(() => fs.lstatSync(externalLink), { code: "ENOENT" });
  assert.equal(fs.readFileSync(externalFile, "utf8"), "keep");
});

test("rejects moving a directory into a descendant whose name begins with two dots", (t) => {
  const { root, roots } = fixture(t);
  const source = path.join(root, "source");
  const descendant = path.join(source, "..child");
  fs.mkdirSync(descendant, { recursive: true });

  assert.throws(
    () => mutateFile({ type: "move", sourcePath: source, destinationDirectory: descendant }, roots),
    (error) => error instanceof FileMutationError && error.status === 400,
  );
  assert.equal(fs.existsSync(source), true);
});

test("rejects moving a directory into itself through an in-root symlink alias", (t) => {
  const { root, roots } = fixture(t);
  const source = path.join(root, "source");
  const alias = path.join(root, "source-alias");
  fs.mkdirSync(source);
  fs.symlinkSync(source, alias, process.platform === "win32" ? "junction" : "dir");

  assert.throws(
    () => mutateFile({ type: "move", sourcePath: source, destinationDirectory: alias }, roots),
    (error) => error instanceof FileMutationError && error.status === 400,
  );
  assert.equal(fs.existsSync(source), true);
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
