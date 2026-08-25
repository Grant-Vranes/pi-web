// eslint-disable-next-line @typescript-eslint/no-require-imports
const net = require("net");

function getTrayIconSize(platform = process.platform) {
  if (platform === "darwin") {
    return { width: 18, height: 18 };
  }
  return { width: 16, height: 16 };
}

function waitForPort(host, port, timeoutMs = 45_000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.createConnection({ host, port });
      socket.once("connect", () => {
        socket.destroy();
        resolve();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() - start >= timeoutMs) {
          reject(new Error(`Timed out waiting for ${host}:${port}`));
          return;
        }
        setTimeout(attempt, 300);
      });
    };
    attempt();
  });
}

function shouldLaunchEmbeddedServer({ externalDevServer, portAlreadyInUse }) {
  if (externalDevServer) {
    return false;
  }
  if (portAlreadyInUse) {
    return false;
  }
  return true;
}

module.exports = {
  getTrayIconSize,
  shouldLaunchEmbeddedServer,
  waitForPort,
};
