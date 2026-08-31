import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./main.cjs", import.meta.url), "utf8");

test("polls the running-session endpoint for the native taskbar indicator", () => {
  assert.match(source, /const RUNNING_STATUS_POLL_MS = 2500/);
  assert.match(source, /fetch\(`\$\{URL\}\/api\/agent\/running`, \{ cache: "no-store" \}\)/);
  assert.match(source, /data\.runningSessionIds\.length > 0/);
  assert.match(source, /startRunningIndicatorPolling\(\);/);
  assert.match(source, /stopRunningIndicatorPolling\(\);/);
});

test("uses each platform's native minimized-app indicator", () => {
  assert.match(source, /mainWindow\.setOverlayIcon\(isRunning \? createRunningOverlayIcon\(\) : null/);
  assert.match(source, /app\.dock\.setBadge\(isRunning \? "●" : ""\)/);
  assert.match(source, /app\.setBadgeCount\(isRunning \? 1 : 0\)/);
});

test("updates the system-tray icon and tooltip when agent activity changes", () => {
  assert.match(source, /if \(isRunning\) \{\s*startRunningTrayAnimation\(\);\s*\} else \{\s*stopRunningTrayAnimation\(\);/);
  assert.match(source, /tray\.setToolTip\(isRunning \? "Pi Web agent is running" : "Pi Web Desktop"\)/);
  assert.match(source, /const RUNNING_TRAY_FRAME_MS = 600/);
  assert.match(source, /function getRunningTrayIconPath\(frame\)/);
  assert.match(source, /function createRunningTrayIcon\(frame\) \{\s*const icon = nativeImage\.createFromPath\(getRunningTrayIconPath\(frame\)\)/);
  assert.match(source, /function startRunningTrayAnimation\(\)/);
  assert.match(source, /setInterval\([\s\S]*?RUNNING_TRAY_FRAME_MS/);
  assert.match(source, /function stopRunningTrayAnimation\(\)[\s\S]*?clearInterval\(runningTrayFrameTimer\)/);
  assert.match(source, /function createTrayIcon\(\)[\s\S]*?icon\.setTemplateImage\(true\)/);
});
