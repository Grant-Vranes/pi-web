// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require("node:fs");

const RETRIABLE_REMOVE_ERRORS = new Set(["ENOTEMPTY", "EBUSY", "EPERM", "EMFILE", "ENFILE"]);

function isRetriableRemoveError(error) {
  return RETRIABLE_REMOVE_ERRORS.has(error?.code);
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function cleanDist({ targetDir = "dist", attempts = 6, fsModule = fs, wait = sleepSync } = {}) {
  let lastError = null;

  for (let index = 0; index < attempts; index += 1) {
    try {
      fsModule.rmSync(targetDir, {
        recursive: true,
        force: true,
        maxRetries: 8,
        retryDelay: 150,
      });
      return;
    } catch (error) {
      lastError = error;
      if (!isRetriableRemoveError(error) || index === attempts - 1) {
        break;
      }
      wait(200 * (index + 1));
    }
  }

  const code = lastError?.code ? ` (${lastError.code})` : "";
  throw new Error(
    `Failed to remove "${targetDir}" after ${attempts} attempts${code}. `
      + "Please close running desktop app instances and file explorers opened inside dist/, then retry.",
    { cause: lastError },
  );
}

module.exports = {
  cleanDist,
  isRetriableRemoveError,
};
