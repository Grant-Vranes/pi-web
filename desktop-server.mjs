// Pi Web desktop sidecar entry.
//
// This replaces bin/pi-web.js for the Tauri desktop shell. bin/pi-web.js spawns
// `next start` as a child process; that launcher model does not fit a bundled
// sidecar (there is no next CLI / node_modules next to the binary). Instead we
// boot Next's server factory directly in-process, which is the form spike-0
// proved works with a bundled node runtime.
//
// Shape mirrors bin/pi-web-options.ts defaults: 127.0.0.1, PORT env or 30141,
// --no-open (the desktop shell owns windowing, never open a browser).

import next from "next";
import { createServer } from "node:http";

const PORT = Number(process.env.PORT || 30141);
const HOST = process.env.PI_WEB_HOSTNAME || "127.0.0.1";

if (!Number.isSafeInteger(PORT) || PORT < 0 || PORT > 65535) {
  console.error(`[pi-web-desktop] Invalid PORT: ${process.env.PORT ?? ""}`);
  process.exit(1);
}

const app = next({ dev: false, hostname: HOST, port: PORT });
const handle = app.getRequestHandler();

let server;

async function main() {
  await app.prepare();
  server = createServer((req, res) => handle(req, res));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(PORT, HOST, () => {
      server.off("error", reject);
      resolve();
    });
  });
  // Tauri's Rust side waits on this exact token via stdout line scan.
  process.stdout.write(`PI_WEB_DESKTOP_READY port=${PORT} host=${HOST}\n`);
}

function shutdown(signal) {
  if (!server) {
    process.exit(0);
    return;
  }
  server.close(() => process.exit(0));
  // Force-exit if graceful close stalls (mirrors bin/process-lifecycle.js).
  setTimeout(() => process.exit(1), 5000).unref();
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => shutdown(sig));
}

main().catch((err) => {
  console.error("[pi-web-desktop] Failed to start:", err);
  process.exit(1);
});
