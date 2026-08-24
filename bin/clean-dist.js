#!/usr/bin/env node
"use strict";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { cleanDist } = require("../lib/clean-dist.cjs");

try {
  cleanDist({ targetDir: "dist" });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}
