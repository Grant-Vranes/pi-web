import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { inflateSync } from "node:zlib";
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
  assert.match(source, /const RUNNING_DOCK_ICON_FRAMES = \["dock-running-dim\.png", "dock-running-bright\.png"\]/);
  assert.match(source, /function setRunningDockIcon\(frame\)/);
  assert.match(source, /app\.dock\.setIcon\(icon\)/);
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
  assert.match(source, /setRunningDockIcon\(runningTrayFrame\)/);
  assert.match(source, /function stopRunningTrayAnimation\(\)[\s\S]*?clearInterval\(runningTrayFrameTimer\)/);
  assert.match(source, /app\.dock\.setIcon\(nativeImage\.createFromPath\(getBaseDockIconPath\(\)\)\)/);
  assert.match(source, /function createTrayIcon\(\)[\s\S]*?icon\.setTemplateImage\(true\)/);
});

function greenBounds(png) {
  let offset = 8; let width = 0; let height = 0; let compressed = Buffer.alloc(0);
  while (offset < png.length) {
    const length = png.readUInt32BE(offset); const type = png.subarray(offset + 4, offset + 8).toString();
    const data = png.subarray(offset + 8, offset + 8 + length); offset += length + 12;
    if (type === "IHDR") { width = data.readUInt32BE(0); height = data.readUInt32BE(4); }
    if (type === "IDAT") compressed = Buffer.concat([compressed, data]);
  }
  const raw = inflateSync(compressed); const stride = width * 4; const pixels = Buffer.alloc(stride * height); let input = 0;
  for (let y = 0; y < height; y++) { assert.equal(raw[input++], 0); raw.copy(pixels, y * stride, input, input + stride); input += stride; }
  let minX = width; let maxX = -1; let minY = height; let maxY = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const i = (y * width + x) * 4; if (pixels[i + 1] > 120 && pixels[i] < 80 && pixels[i + 2] > 40) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); } }
  return { width: maxX - minX + 1, height: maxY - minY + 1 };
}

test("uses a large bottom-right breathing light", async () => {
  const png = await readFile(new URL("../public/icons/tray-running-bright.png", import.meta.url));
  const bounds = greenBounds(png);
  assert.ok(bounds.width >= 60 && bounds.height >= 60, `status light is too small: ${JSON.stringify(bounds)}`);
});

function greenBoundsRelaxed(png) {
  let offset = 8; let width = 0; let height = 0; let compressed = Buffer.alloc(0);
  while (offset < png.length) {
    const length = png.readUInt32BE(offset); const type = png.subarray(offset + 4, offset + 8).toString();
    const data = png.subarray(offset + 8, offset + 8 + length); offset += length + 12;
    if (type === "IHDR") { width = data.readUInt32BE(0); height = data.readUInt32BE(4); }
    if (type === "IDAT") compressed = Buffer.concat([compressed, data]);
  }
  const raw = inflateSync(compressed); const stride = width * 4; const pixels = Buffer.alloc(stride * height); let input = 0;
  for (let y = 0; y < height; y++) { assert.equal(raw[input++], 0); raw.copy(pixels, y * stride, input, input + stride); input += stride; }
  let minX = width; let maxX = -1; let minY = height; let maxY = -1;
  // Relaxed threshold so the dim frame (green channel ~87) is also detected.
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const i = (y * width + x) * 4; if (pixels[i + 1] > 80 && pixels[i] < 80 && pixels[i + 2] > 30) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); } }
  return { width: maxX - minX + 1, height: maxY - minY + 1, minX, maxX, minY, maxY, imgWidth: width, imgHeight: height };
}

test("dock icon frames show a top-right green breathing dot", async () => {
  for (const name of ["dock-running-bright.png", "dock-running-dim.png"]) {
    const png = await readFile(new URL(`../public/icons/${name}`, import.meta.url));
    const b = greenBoundsRelaxed(png);
    assert.ok(b.maxX >= 0, `${name} has no green dot`);
    assert.ok(b.width >= 80 && b.height >= 80, `${name} dock dot too small: ${JSON.stringify(b)}`);
    // Dot must sit in the top-right quadrant of the icon.
    assert.ok(b.minX >= b.imgWidth / 2, `${name} dot not in right half: ${JSON.stringify(b)}`);
    assert.ok(b.maxY <= b.imgHeight / 2, `${name} dot not in top half: ${JSON.stringify(b)}`);
  }
});
