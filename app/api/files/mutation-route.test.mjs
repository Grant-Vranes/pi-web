import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const source = await readFile(new URL("./[...path]/route.ts", import.meta.url), "utf8");

test("mutation requests are guarded and delegated to the canonical mutation service", () => {
  assert.match(source, /const FILE_MUTATION_TYPES = \["create-file", "create-directory", "rename", "move", "copy", "delete", "write"\] as const/);
  assert.match(source, /if \(!isApiRequestAllowed\(request\)\)/);
  assert.match(source, /const allowedRoots = await getAllowedFileRoots\(\)/);
  assert.match(source, /mutateFile\(mutation, allowedRoots\)/);
  assert.match(source, /error instanceof FileMutationError/);
});

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { POST } = await jiti.import("./[...path]/route.ts");
const { NextRequest } = await jiti.import("next/server");
const { allowFileRoot } = await jiti.import("@/lib/file-access");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-files-mutation-"));
  allowFileRoot(root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function routeContext(filePath) {
  return { params: Promise.resolve({ path: filePath.split("/").filter(Boolean) }) };
}

async function callMutation(filePath, type, body) {
  const segments = filePath.split("/").filter(Boolean).map(encodeURIComponent);
  const url = `http://localhost/api/files/${segments.join("/")}?type=${type}`;
  const request = new NextRequest(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Host: "localhost" },
    body: JSON.stringify(body ?? {}),
  });
  return POST(request, routeContext(filePath));
}

test("copy duplicates files and directories within the allowed root", async (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, "source.txt"), "hello");
  fs.mkdirSync(path.join(root, "src"));
  fs.mkdirSync(path.join(root, "dest"));
  fs.writeFileSync(path.join(root, "src", "m.ts"), "export {}");
  fs.symlinkSync(path.join(root, "source.txt"), path.join(root, "src", "link.txt"));

  const response = await callMutation(path.join(root, "source.txt"), "copy", { destinationDirectory: path.join(root, "dest") });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.deleted, false);
  assert.equal(body.destinationPath, path.join(root, "dest", "source.txt"));
  assert.equal(fs.readFileSync(path.join(root, "dest", "source.txt"), "utf8"), "hello");
  assert.ok(fs.existsSync(path.join(root, "source.txt")));

  const directoryResponse = await callMutation(path.join(root, "src"), "copy", { destinationDirectory: path.join(root, "dest") });
  assert.equal(directoryResponse.status, 200);
  assert.equal(fs.readFileSync(path.join(root, "dest", "src", "m.ts"), "utf8"), "export {}");
  // Symlinks are copied as links, never dereferenced.
  assert.ok(fs.lstatSync(path.join(root, "dest", "src", "link.txt")).isSymbolicLink());
});

test("keep-both picks successive copy names with and without extensions", async (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, "a.txt"), "1");
  fs.writeFileSync(path.join(root, "a copy.txt"), "2");
  fs.writeFileSync(path.join(root, "README"), "r");

  const response = await callMutation(path.join(root, "a.txt"), "copy", { destinationDirectory: root, conflict: "keep-both" });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(path.basename(body.destinationPath), "a copy 2.txt");

  const readmeResponse = await callMutation(path.join(root, "README"), "copy", { destinationDirectory: root, conflict: "keep-both" });
  assert.equal(readmeResponse.status, 200);
  const readmeBody = await readmeResponse.json();
  assert.equal(path.basename(readmeBody.destinationPath), "README copy");
});

test("copy and move default to 409 on name conflicts", async (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, "a.txt"), "1");

  const copyResponse = await callMutation(path.join(root, "a.txt"), "copy", { destinationDirectory: root });
  assert.equal(copyResponse.status, 409);
  const moveResponse = await callMutation(path.join(root, "a.txt"), "move", { destinationDirectory: root });
  assert.equal(moveResponse.status, 409);
});

test("overwrite removes the existing destination before copying or moving", async (t) => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, "dir"));
  fs.writeFileSync(path.join(root, "a.txt"), "new");
  fs.writeFileSync(path.join(root, "dir", "a.txt"), "old");
  fs.writeFileSync(path.join(root, "b.txt"), "moved");

  const copyResponse = await callMutation(path.join(root, "a.txt"), "copy", { destinationDirectory: path.join(root, "dir"), conflict: "overwrite" });
  assert.equal(copyResponse.status, 200);
  assert.equal(fs.readFileSync(path.join(root, "dir", "a.txt"), "utf8"), "new");

  const moveResponse = await callMutation(path.join(root, "b.txt"), "move", { destinationDirectory: path.join(root, "dir"), conflict: "overwrite" });
  assert.equal(moveResponse.status, 200);
  assert.equal(fs.readFileSync(path.join(root, "dir", "b.txt"), "utf8"), "moved");
  assert.ok(!fs.existsSync(path.join(root, "b.txt")));
});

test("move keep-both renames the incoming entry instead of failing", async (t) => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, "from"));
  fs.mkdirSync(path.join(root, "to"));
  fs.writeFileSync(path.join(root, "from", "a.txt"), "A");
  fs.writeFileSync(path.join(root, "to", "a.txt"), "B");

  const response = await callMutation(path.join(root, "from", "a.txt"), "move", { destinationDirectory: path.join(root, "to"), conflict: "keep-both" });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(path.basename(body.destinationPath), "a copy.txt");
  assert.equal(fs.readFileSync(path.join(root, "to", "a.txt"), "utf8"), "B");
  assert.equal(fs.readFileSync(path.join(root, "to", "a copy.txt"), "utf8"), "A");
});

test("copy rejects sources and destinations outside allowed roots", async (t) => {
  const root = fixture(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-outside-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "a.txt"), "1");
  fs.writeFileSync(path.join(outside, "secret.txt"), "s");

  const badDestination = await callMutation(path.join(root, "a.txt"), "copy", { destinationDirectory: outside });
  assert.equal(badDestination.status, 403);
  const badSource = await callMutation(path.join(outside, "secret.txt"), "copy", { destinationDirectory: root });
  assert.equal(badSource.status, 403);
});

test("copy refuses to copy a directory into itself", async (t) => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, "src", "nested"), { recursive: true });
  const response = await callMutation(path.join(root, "src"), "copy", { destinationDirectory: path.join(root, "src", "nested") });
  assert.equal(response.status, 400);
});

test("invalid conflict mode is a 400", async (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, "a.txt"), "1");
  const response = await callMutation(path.join(root, "a.txt"), "copy", { destinationDirectory: root, conflict: "merge" });
  assert.equal(response.status, 400);
});

test("overwrite into a source descendant is rejected without deleting the existing destination", async (t) => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, "src", "nested", "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "nested", "src", "marker.txt"), "keep me");

  const response = await callMutation(path.join(root, "src"), "copy", {
    destinationDirectory: path.join(root, "src", "nested"),
    conflict: "overwrite",
  });
  assert.equal(response.status, 400);
  // The pre-existing destination must survive the rejected operation.
  assert.equal(fs.readFileSync(path.join(root, "src", "nested", "src", "marker.txt"), "utf8"), "keep me");

  const moveResponse = await callMutation(path.join(root, "src"), "move", {
    destinationDirectory: path.join(root, "src", "nested"),
    conflict: "overwrite",
  });
  assert.equal(moveResponse.status, 400);
  assert.equal(fs.readFileSync(path.join(root, "src", "nested", "src", "marker.txt"), "utf8"), "keep me");
});

test("overwrite through a symlink alias of the source is a no-op", async (t) => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, "data"));
  fs.writeFileSync(path.join(root, "data", "a.txt"), "x");
  fs.symlinkSync(path.join(root, "data"), path.join(root, "alias"));

  const response = await callMutation(path.join(root, "data", "a.txt"), "copy", {
    destinationDirectory: path.join(root, "alias"),
    conflict: "overwrite",
  });
  assert.equal(response.status, 200);
  // The source survives and nothing is duplicated through the alias.
  assert.equal(fs.readFileSync(path.join(root, "data", "a.txt"), "utf8"), "x");
  assert.equal(fs.readdirSync(path.join(root, "data")).length, 1);
});

test("copying a symlink recreates the link", async (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, "target.txt"), "t");
  fs.symlinkSync(path.join(root, "target.txt"), path.join(root, "link"));
  fs.mkdirSync(path.join(root, "dest"));

  const response = await callMutation(path.join(root, "link"), "copy", { destinationDirectory: path.join(root, "dest") });
  assert.equal(response.status, 200);
  const copied = path.join(root, "dest", "link");
  assert.ok(fs.lstatSync(copied).isSymbolicLink());
  assert.equal(fs.readFileSync(copied, "utf8"), "t");
  // The original target is untouched.
  assert.equal(fs.readFileSync(path.join(root, "target.txt"), "utf8"), "t");
});
