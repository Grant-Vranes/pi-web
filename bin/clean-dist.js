#!/usr/bin/env node
"use strict";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { cleanDist } = require("../lib/clean-dist.cjs");

// `dist/` is the desktop build output. `.next/` is removed too because a stale
// `.next/dev/types/` left behind by `next dev` is included by tsconfig.json and
// can reference route modules that have since been deleted, failing the
// `next build` type check.
const targets = ["dist", ".next"];

for (const targetDir of targets) {
  try {
    cleanDist({ targetDir });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
  }
}
