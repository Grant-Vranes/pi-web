#!/usr/bin/env node
"use strict";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { spawn } = require("child_process");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("path");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { parseLaunchOptions } = require("./pi-web-options");

const pkgDir = path.join(__dirname, "..");
let nextBin;
try {
  nextBin = require.resolve("next/dist/bin/next", { paths: [pkgDir] });
} catch {
  const nextPkg = require.resolve("next/package.json", { paths: [pkgDir] });
  nextBin = path.join(path.dirname(nextPkg), "dist", "bin", "next");
}

const { port, hostname } = parseLaunchOptions();
const child = spawn(process.execPath, [nextBin, "dev", "-H", hostname, "-p", port], {
  cwd: pkgDir,
  stdio: "inherit",
  env: { ...process.env, PORT: port, PI_WEB_HOSTNAME: hostname },
});

child.on("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
