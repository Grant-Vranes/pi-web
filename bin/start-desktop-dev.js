#!/usr/bin/env node
"use strict";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { spawn } = require("child_process");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("path");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { parseLaunchOptions } = require("./pi-web-options");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { waitForPort } = require("../desktop/runtime-helpers.cjs");

const pkgDir = path.join(__dirname, "..");
const { port } = parseLaunchOptions(["--hostname", "127.0.0.1"]);
const childEnv = { ...process.env, PORT: port, PI_WEB_HOSTNAME: "127.0.0.1" };
let devServer;
let electron;
let stopping = false;

function stopChild(child, signal = "SIGTERM") {
  if (child && !child.killed) child.kill(signal);
}

function stopAll(signal) {
  if (stopping) return;
  stopping = true;
  stopChild(devServer, signal);
  stopChild(electron, signal);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => stopAll(signal));
}

async function main() {
  devServer = spawn(process.execPath, [path.join(__dirname, "start-dev.js"), "--hostname", "127.0.0.1"], {
    cwd: pkgDir,
    stdio: "inherit",
    env: childEnv,
  });
  devServer.on("exit", (code) => {
    if (!stopping) {
      stopAll();
      process.exitCode = code ?? 1;
    }
  });

  try {
    await waitForPort("127.0.0.1", Number(port));
  } catch (error) {
    console.error(error);
    stopAll();
    process.exitCode = 1;
    return;
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const electronBin = require("electron");
  electron = spawn(electronBin, [path.join(pkgDir, "desktop", "main.cjs")], {
    cwd: pkgDir,
    stdio: "inherit",
    env: { ...childEnv, PI_WEB_DESKTOP_DEV: "1" },
  });
  electron.on("exit", (code) => {
    stopAll();
    process.exitCode = code ?? 0;
  });
}

void main();
