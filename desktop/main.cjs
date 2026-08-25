// eslint-disable-next-line @typescript-eslint/no-require-imports
const { app, BrowserWindow, Menu, Tray, nativeImage, shell, clipboard, dialog, ipcMain } = require("electron");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { spawn } = require("child_process");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const net = require("net");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("path");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getTrayIconSize, shouldLaunchEmbeddedServer, waitForPort } = require("./runtime-helpers.cjs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { parseLaunchOptions } = require("../bin/pi-web-options");

const HOST = "127.0.0.1";
const { port: configuredPort } = parseLaunchOptions(["--hostname", HOST]);
const PORT = Number(configuredPort);
const URL = `http://${HOST}:${PORT}`;
const CONTEXT_MENU_CHANNEL = "pi-web:show-session-row-contextmenu";
const CONFIRM_DELETE_CHANNEL = "pi-web:confirm-delete-session";

let mainWindow = null;
let tray = null;
let serverProc = null;
let isQuitting = false;

function isPortReachable(host, port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;

    const done = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(value);
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

function getTrayIconPath() {
  return path.join(app.getAppPath(), "public", "icons", "icon-192.png");
}

function showMainWindow() {
  if (!mainWindow) {
    return;
  }
  mainWindow.show();
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.focus();
  if (process.platform === "darwin") {
    app.dock.show();
  }
}

function createTray() {
  if (tray) {
    return;
  }

  const icon = nativeImage.createFromPath(getTrayIconPath()).resize(getTrayIconSize(process.platform));
  if (process.platform === "darwin") {
    icon.setTemplateImage(true);
  }
  tray = new Tray(icon);
  tray.setToolTip("Pi Web Desktop");
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: "显示 Pi Web",
      click: () => showMainWindow(),
    },
    {
      type: "separator",
    },
    {
      label: "退出",
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]));

  tray.on("double-click", showMainWindow);
  tray.on("click", showMainWindow);
}

function startPiWebServer() {
  const scriptPath = path.join(app.getAppPath(), "bin", "pi-web.js");
  serverProc = spawn(
    process.execPath,
    [scriptPath, "--hostname", HOST, "--port", String(PORT), "--no-open"],
    {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        PI_WEB_NO_OPEN: "1",
        PI_WEB_HOSTNAME: HOST,
        PORT: String(PORT),
      },
      stdio: "inherit",
    },
  );

  serverProc.on("exit", (code, signal) => {
    serverProc = null;
    if (!isQuitting && code !== 0) {
      dialog.showErrorBox("Pi Web 服务异常退出", `code=${code ?? "unknown"}, signal=${signal ?? "none"}`);
    }
  });
}

function shouldUseExternalDevServer() {
  return process.env.PI_WEB_DESKTOP_DEV === "1";
}

function setupIpcHandlers() {
  ipcMain.handle(CONTEXT_MENU_CHANNEL, async (event, payload) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) {
      return null;
    }

    const { id, path: sessionPath, cwd, name, clientX, clientY } = payload || {};
    if (!id || !sessionPath || !cwd) {
      return null;
    }

    return new Promise((resolve) => {
      let resolved = false;
      const done = (value) => {
        if (resolved) {
          return;
        }
        resolved = true;
        resolve(value);
      };

      const menu = Menu.buildFromTemplate([
        {
          label: name ? `会话：${name}` : `会话：${id}`,
          enabled: false,
        },
        { type: "separator" },
        {
          label: "复制会话 ID",
          click: () => {
            clipboard.writeText(id);
            done("copied");
          },
        },
        {
          label: "复制会话文件路径",
          click: () => {
            clipboard.writeText(sessionPath);
            done("copied");
          },
        },
        {
          label: "复制工作目录",
          click: () => {
            clipboard.writeText(cwd);
            done("copied");
          },
        },
        {
          label: "在文件管理器中显示会话文件",
          click: () => {
            shell.showItemInFolder(sessionPath);
            done("revealed");
          },
        },
        { type: "separator" },
        {
          label: "删除会话…",
          click: () => {
            done("delete");
          },
        },
      ]);

      menu.popup({
        window: win,
        x: Number.isFinite(clientX) ? Math.round(clientX) : undefined,
        y: Number.isFinite(clientY) ? Math.round(clientY) : undefined,
        callback: () => done(null),
      });
    });
  });

  ipcMain.handle(CONFIRM_DELETE_CHANNEL, async (_event, payload) => {
    const { name, id } = payload || {};
    const title = name ? `删除会话“${name}”？` : "删除该会话？";
    const detail = id ? `会话 ID: ${id}\n删除后无法恢复。` : "删除后无法恢复。";
    const result = await dialog.showMessageBox({
      type: "warning",
      buttons: ["取消", "删除"],
      defaultId: 0,
      cancelId: 0,
      title: "确认删除",
      message: title,
      detail,
      noLink: true,
    });
    return result.response === 1;
  });
}

async function createWindow() {
  const externalDevServer = shouldUseExternalDevServer();
  const portAlreadyInUse = await isPortReachable(HOST, PORT);

  if (shouldLaunchEmbeddedServer({ externalDevServer, portAlreadyInUse })) {
    startPiWebServer();
  } else if (portAlreadyInUse && !externalDevServer) {
    console.log(`[pi-web desktop] Reusing existing server on ${HOST}:${PORT}`);
  }

  await waitForPort(HOST, PORT);

  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 980,
    minHeight: 680,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(app.getAppPath(), "desktop", "preload.cjs"),
    },
  });

  mainWindow.on("close", (event) => {
    if (isQuitting) {
      return;
    }
    event.preventDefault();
    mainWindow.hide();
    if (process.platform === "darwin") {
      app.dock.hide();
    }
  });

  await mainWindow.loadURL(URL);
  mainWindow.once("ready-to-show", () => {
    showMainWindow();
  });
}

app.whenReady().then(async () => {
  setupIpcHandlers();
  createTray();

  try {
    await createWindow();
  } catch (error) {
    dialog.showErrorBox("Pi Web Desktop 启动失败", error instanceof Error ? error.message : String(error));
    app.quit();
  }

  app.on("activate", () => {
    if (!mainWindow) {
      void createWindow();
      return;
    }
    showMainWindow();
  });
});

app.on("before-quit", () => {
  isQuitting = true;
  if (serverProc && !serverProc.killed) {
    serverProc.kill("SIGTERM");
  }
});

app.on("window-all-closed", () => {
  // Keep app alive in tray on all platforms.
});
