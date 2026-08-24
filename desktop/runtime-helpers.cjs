function getTrayIconSize(platform = process.platform) {
  if (platform === "darwin") {
    return { width: 18, height: 18 };
  }
  return { width: 16, height: 16 };
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
};
