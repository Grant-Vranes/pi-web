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
//
// Native addon packages ship platform-specific prebuilds as sibling optional
// packages (e.g. @tailwindcss/oxide-linux-x64-gnu alongside ...-x64-musl,
// @mariozechner/clipboard-linux-arm64-gnu, @img/sharp-wasm32). Only the
// prebuild matching the host platform is ever loaded by Node. The rest are
// dead weight, and on Linux they actively break AppImage bundling: linuxdeploy
// runs `ldd` over every staged ELF, and glibc's ldd exits non-zero on musl
// objects ("invalid ELF header") or fails to find libc.musl-x86_64.so.1,
// aborting the bundle. Exclude every non-host native prebuild directory so the
// staged tree only carries ELFs linuxdeploy can inspect.
const nativePrebuildExclude = (() => {
  // Match the final path segment of a native-prebuild package directory.
  // Keep this aligned with the platforms Node/npm use for optionalDeps triples.
  const neverOnLinux = [
    /-musl(?!-)/i, /linuxmusl/i, /-arm64-/i, /-arm-/i, /-riscv64-/i,
    /-wasm32/i, /-win32-/i, /-darwin-/i, /-freebsd-/i, /-aix-/i, /-sunos-/i,
    /-android-/i, /-linux-arm/i, /-linux-riscv/i,
  ];
  return process.platform === "linux" ? neverOnLinux : null;
})();
const segmentIsExcludedPrebuild = (segment) => {
  if (!nativePrebuildExclude) return false;
  return nativePrebuildExclude.some((re) => re.test(segment));
};
copy(source("node_modules"), path.join(destination, "node_modules"), {
  filter: (entry) => {
    if (!nativePrebuildExclude) return true;
    const relative = path.relative(source("node_modules"), entry);
    // Exclude when the offending prebuild package is the entry itself or any
    // ancestor directory in the staged path (so nested copies under
    // @earendil-works/pi-coding-agent/node_modules/... are dropped too).
    return relative.split(path.sep).every((segment) => !segmentIsExcludedPrebuild(segment));
  },
});

console.log(`[tauri-runtime] staged ${destination}`);
