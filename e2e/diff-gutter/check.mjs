import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { readFileSync, statSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const dir = join(root, "e2e", "diff-gutter");

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const server = createServer((req, res) => {
  let path = new URL(req.url, "http://x").pathname;
  if (path === "/") path = "/index.html";
  const file = path === "/app.js" ? join(dir, "dist", "app.js") : join(dir, ...path.split("/").filter(Boolean));
  let body;
  try {
    body = readFileSync(file);
  } catch {
    console.log("404 req:", req.url);
    res.writeHead(404);
    res.end("nope");
    return;
  }
  const type = MIME[extname(file)] ?? "application/octet-stream";
  res.writeHead(200, { "content-type": type });
  res.end(body);
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch().catch(() => {
  const candidates = [
    "$HOME/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  ].map((p) => p.replace("$HOME", process.env.HOME));
  return chromium.launch({ executablePath: candidates.find((p) => statSync(p, { throwIfNoEntry: false }).isFile()), headless: true });
});

try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
  page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") console.log("CONSOLE", m.type() + ":", m.text()); });
  await page.goto(origin, { waitUntil: "load" });
  await page.waitForSelector(".cm-editor .cm-change-gutter", { timeout: 10000 });
  console.log("change gutter present");

  // No edits yet -> no marker bars.
  assert.equal(await page.locator(".cm-change-mod-bar, .cm-change-add-bar").count(), 0, "no bars before edits");

  // Modify line 2 of the sample and insert a new third line.
  await page.evaluate(() => {
    globalThis.applyText("line one\nline twoy\nline three\nline four\n");
  });
  await page.waitForSelector(".cm-change-mod-bar, .cm-change-add-bar", { timeout: 8000 });
  const modBars = await page.locator(".cm-change-mod-bar").count();
  const addBars = await page.locator(".cm-change-add-bar").count();
  console.log("after edit -> modified bars:", modBars, "added bars:", addBars);
  assert.ok(modBars >= 1, "a modified bar should appear");
  assert.ok(addBars >= 1, "an added bar should appear");

  // Colors match the FileViewer spec (#f59e0b amber, #4ade80 green).
  const modColor = await page.locator(".cm-change-mod-bar").first().evaluate((el) => getComputedStyle(el).backgroundColor);
  const addColor = await page.locator(".cm-change-add-bar").first().evaluate((el) => getComputedStyle(el).backgroundColor);
  assert.equal(modColor, "rgb(245, 158, 11)", `modified bar color ${modColor}`);
  assert.equal(addColor, "rgb(74, 222, 128)", `added bar color ${addColor}`);

  // Reverting the doc to baseline should clear all bars.
  await page.evaluate(() => globalThis.applyText("line one\nline two\nline three\n"));
  await page.waitForTimeout(300);
  assert.equal(await page.locator(".cm-change-mod-bar, .cm-change-add-bar").count(), 0, "bars cleared after reverting");
  console.log("bars cleared after revert to baseline");

  console.log("PASS: change-indicator gutter renders modified+added bars with correct colors");
} finally {
  await browser.close();
  server.close();
}