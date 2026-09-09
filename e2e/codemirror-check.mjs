// Manual/CI verification: CodeMirror syntax highlighting in the file editor's
// edit mode. Seeds an isolated agent dir + project with a TypeScript sample,
// opens it as a file tab, enters edit mode, and checks the syntax token colors
// match the read-only preview's Prism themes (vs light / vscDarkPlus dark).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { setTimeout as delay } from "node:timers/promises";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
assert.ok(!existsSync(join(root, ".next/dev/lock")), "Run on a checkout without an active dev server");

const agentDir = mkdtempSync(join(tmpdir(), "pi-web-cm-"));
const project = join(agentDir, "project");
mkdirSync(project, { recursive: true });
const sessionDir = join(agentDir, "sessions", "cm");
mkdirSync(sessionDir, { recursive: true });

const SAMPLE = `const PI = 3.14159;
export function area(radius: number): number {
  // radius is in metres
  return PI * radius * radius;
}
`;
writeFileSync(join(project, "sample.ts"), SAMPLE);

const id = "cm-editor-session";
const timestamp = "2026-08-23T00:00:00.000Z";
writeFileSync(join(sessionDir, `${timestamp}_${id}.jsonl`),
  [JSON.stringify({ type: "session", version: 3, id, timestamp, cwd: project }), JSON.stringify(
    { type: "message", id: "m1", parentId: null, timestamp, message: { role: "user", content: "open sample.ts" } })].join("\n") + "\n");

const probe = createServer();
probe.listen(0, "127.0.0.1");
await once(probe, "listening");
const port = probe.address().port;
await new Promise((resolve, reject) => probe.close((e) => (e ? reject(e) : resolve())));
const base = `http://127.0.0.1:${port}`;

const themeToExpected = {
  light: { rgb: "rgb(0, 0, 255)", label: "vs (light)" },   // vs keyword color
  dark: { rgb: "rgb(86, 156, 214)", label: "vscDarkPlus (dark)" }, // vscDarkPlus keyword color
};

let server;
async function runPass(page, theme) {
  await page.evaluate((pref) => localStorage.setItem("pi-theme", pref), theme);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByText("sample.ts", { exact: true }).first().click({ timeout: 20000 });
  await page.getByRole("button", { name: "Edit", exact: true }).first().click({ timeout: 20000 });
  await page.waitForSelector(".cm-editor", { timeout: 20000 });
  const text = await page.locator(".cm-editor").innerText();
  assert.ok(text.includes("3.14159"), `${theme}: editor shows source`);
  const keyword = page.locator(".cm-content span").filter({ hasText: "const" }).first();
  const color = await keyword.evaluate((el) => getComputedStyle(el).color);
  console.log(`[${theme}] editor renders, keyword color = ${color} (expect ${themeToExpected[theme].rgb}, ${themeToExpected[theme].label})`);
  assert.equal(color, themeToExpected[theme].rgb, `keyword color should match ${theme}`);
  const gutter = await page.locator(".cm-gutters .cm-gutterElement").count();
  assert.ok(gutter >= 4, `${theme}: line-number gutter present`);
  console.log(`[${theme}] line-number gutter cells: ${gutter}`);
  // Search integration: the app's own search bar drives CodeMirror decorations.
  await page.getByRole("button", { name: "Search in file", exact: true }).first().click();
  await page.getByRole("textbox", { name: "Search in file", exact: true }).fill("radius");
  await page.waitForSelector(".cm-editor .file-source-search-hit", { timeout: 8000 });
  const hits = await page.locator(".cm-editor .file-source-search-hit").count();
  console.log(`[${theme}] search-hit decorations in edit mode: ${hits}`);
  assert.ok(hits >= 2, `${theme}: search matches highlighted in the editor`);
  await page.keyboard.press("Escape"); // close search

  // Change indicators: editing a line must paint an amber (modified) bar in the
  // change gutter, and inserting a new line must paint a green (added) bar.
  await page.locator(".cm-editor .cm-line").first().click();
  await page.keyboard.press("End");
  await page.keyboard.type(" // changed", { delay: 10 });
  await page.waitForSelector(".cm-editor .cm-change-mod-bar", { timeout: 8000 });
  const modBars = await page.locator(".cm-editor .cm-change-mod-bar").count();
  assert.ok(modBars >= 1, `${theme}: modified line has a change-indicator bar`);
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("const EXTRA = 1;", { delay: 10 });
  await page.waitForSelector(".cm-editor .cm-change-add-bar", { timeout: 8000 });
  const addBars = await page.locator(".cm-editor .cm-change-add-bar").count();
  assert.ok(addBars >= 1, `${theme}: inserted line has an added change-indicator bar`);
  const gutterClass = await page.locator(".cm-editor .cm-change-gutter").count();
  assert.equal(gutterClass, 1, `${theme}: change gutter element present`);
  console.log(`[${theme}] change-indicator gutter bars -> modified: ${modBars}, added: ${addBars}`);
}

try {
  server = spawn(process.execPath, [join(root, "node_modules/next/dist/bin/next"), "dev", "-H", "127.0.0.1", "-p", String(port)], {
    cwd: root,
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_WEB_PASSWORD: "", NEXT_TELEMETRY_DISABLED: "1" },
    stdio: "ignore",
  });
  for (let tries = 0; tries < 120; tries++) {
    if (server.exitCode !== null) throw new Error("server exited during startup");
    try { const r = await fetch(`${base}/api/sessions`, { signal: AbortSignal.timeout(3000) }); if (r.ok) break; } catch {}
    await delay(250);
  }

  const browser = await chromium.launch().catch(() => {
    // Fall back to a locally installed (older) Chrome for Testing when the
    // pinned Playwright build is not installed on this machine.
    const candidates = [
      "$HOME/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    ].map((p) => p.replace("$HOME", process.env.HOME));
    return chromium.launch({ executablePath: candidates.find((p) => existsSync(p)), headless: true });
  });
  const context = await browser.newContext({ locale: "en-US" });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
  await page.goto(`${base}/?session=${id}`, { waitUntil: "domcontentloaded" });

  await runPass(page, "light");
  await runPass(page, "dark");

  await browser.close();
  console.log("PASS: CodeMirror edit-mode highlighting matches read-only vs + vscDarkPlus themes");
} finally {
  server?.kill("SIGTERM");
  await once(server, "exit").catch(() => {});
}
rmSync(agentDir, { recursive: true, force: true });