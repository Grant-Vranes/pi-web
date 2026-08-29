#!/usr/bin/env node
"use strict";

// Stages the Node runtime and the exact Next.js runtime tree consumed by the
// Tauri release shell. Electron supplied Node itself; Tauri intentionally does
// not, so the desktop package must carry a compatible Node binary.
//
// This runs only from the desktop packaging command, after `npm run build`.
// The generated desktop-runtime/ directory is gitignored.

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const destination = path.join(root, "desktop-runtime");
const source = (...parts) => path.join(root, ...parts);
const copy = (from, to, options = {}) => {
  if (!fs.existsSync(from)) {
    throw new Error(`Required desktop runtime input is missing: ${from}`);
  }
  fs.cpSync(from, to, { recursive: true, ...options });
};

if (!fs.existsSync(source(".next", "BUILD_ID"))) {
  throw new Error("Next.js production artifacts are missing. Run `npm run build` before staging Tauri runtime.");
}

fs.rmSync(destination, { recursive: true, force: true });
fs.mkdirSync(destination, { recursive: true });

// Keep the Node filename stable for Rust. process.execPath is the active Node
// version, which must satisfy package.json's engines.node constraint.
const nodeDir = path.join(destination, "node");
fs.mkdirSync(nodeDir, { recursive: true });
const nodeName = process.platform === "win32" ? "node.exe" : "node";
copy(process.execPath, path.join(nodeDir, nodeName));
if (process.platform !== "win32") {
  fs.chmodSync(path.join(nodeDir, nodeName), 0o755);
}

copy(source("desktop-server.mjs"), path.join(destination, "desktop-server.mjs"));
copy(source("package.json"), path.join(destination, "package.json"));
copy(source("next.config.ts"), path.join(destination, "next.config.ts"));

// Next's production server must see its complete output but never needs local
// dev caches. Excluding them keeps the packaged resources deterministic and
// dramatically smaller.
copy(source(".next"), path.join(destination, ".next"), {
  filter: (entry) => {
    const relative = path.relative(source(".next"), entry);
    return relative !== "cache" && !relative.startsWith(`cache${path.sep}`)
      && relative !== "dev" && !relative.startsWith(`dev${path.sep}`);
  },
});

// The project currently declares several SSR imports under devDependencies and
// Next loads some transitive modules dynamically. Copying the installed tree is
// deliberately conservative: it matches today's Electron runtime behavior and
// avoids breaking dynamic extensions / pi SDK loading in the packaged app.
copy(source("node_modules"), path.join(destination, "node_modules"));

console.log(`[tauri-runtime] staged ${destination}`);
