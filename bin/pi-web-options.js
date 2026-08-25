"use strict";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require("fs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("path");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { parseArgs, parseEnv } = require("util");

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

function isEnabled(value) {
  return typeof value === "string" && TRUE_VALUES.has(value.trim().toLowerCase());
}

function normalizePort(value) {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new Error("Port must be a non-negative integer.");
  }

  const port = Number(value);
  if (!Number.isSafeInteger(port) || port > 65535) {
    throw new Error("Port must be between 0 and 65535.");
  }

  return String(port);
}

function readProjectEnv(cwd = process.cwd()) {
  const envPath = path.join(cwd, ".env.local");
  if (!fs.existsSync(envPath)) {
    return {};
  }
  return parseEnv(fs.readFileSync(envPath, "utf8"));
}

function parseLaunchOptions(args = process.argv.slice(2), env = process.env, { cwd = process.cwd() } = {}) {
  const resolvedEnv = { ...readProjectEnv(cwd), ...env };
  const { values: cliArgs } = parseArgs({
    args,
    options: {
      port:      { type: "string", short: "p" },
      hostname:  { type: "string", short: "H" },
      "no-open": { type: "boolean" },
    },
    strict: false,
  });

  return {
    port: normalizePort(cliArgs.port ?? resolvedEnv.PORT ?? "30141"),
    hostname: cliArgs.hostname ?? resolvedEnv.PI_WEB_HOSTNAME ?? "127.0.0.1",
    openBrowser: !cliArgs["no-open"] && !isEnabled(resolvedEnv.PI_WEB_NO_OPEN),
  };
}

module.exports = { parseLaunchOptions, readProjectEnv };
