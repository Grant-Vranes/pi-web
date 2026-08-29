#!/usr/bin/env node
"use strict";

// Tauri reads `build.devUrl` before it runs `beforeDevCommand`, while Pi Web
// resolves its port from .env.local. Create a checkout-local temporary config
// so both sides use the same port for a desktop development session.
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { parseLaunchOptions } = require("./pi-web-options");

const projectRoot = path.join(__dirname, "..");
const sourceConfig = path.join(projectRoot, "src-tauri", "tauri.conf.json");
const generatedConfig = path.join(projectRoot, "src-tauri", ".tauri.dev.conf.json");
const { port } = parseLaunchOptions([], process.env, { cwd: projectRoot });
const config = JSON.parse(fs.readFileSync(sourceConfig, "utf8"));
config.build.devUrl = `http://127.0.0.1:${port}`;
fs.writeFileSync(generatedConfig, `${JSON.stringify(config, null, 2)}\n`);

const cli = require.resolve("@tauri-apps/cli/tauri.js", { paths: [projectRoot] });
const child = spawn(process.execPath, [cli, "dev", "--config", generatedConfig, ...process.argv.slice(2)], {
  cwd: projectRoot,
  stdio: "inherit",
  env: { ...process.env, PORT: port },
});

let cleanedUp = false;
function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  try {
    fs.unlinkSync(generatedConfig);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

child.on("exit", (code, signal) => {
  cleanup();
  process.exitCode = code ?? (signal ? 1 : 0);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => child.kill(signal));
}
