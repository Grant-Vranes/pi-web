# Desktop Tray Running Indicator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a visible running-state indicator in the Pi Web Desktop system-tray icon on Windows, Linux, and macOS whenever one or more agent sessions are active.

**Architecture:** `desktop/main.cjs` already obtains the aggregate running state through a 2.5-second request to `/api/agent/running`. Extend the existing state-transition handler to update the Electron `Tray` image and tooltip, while retaining the Windows taskbar overlay, macOS Dock badge, and Linux launcher badge. Keep all platform behavior in the main process and preserve the last known state when polling fails.

**Tech Stack:** Electron `Tray` and `nativeImage`, Node.js built-in test runner, CommonJS desktop main process.

## Global Constraints

- The same tray running-state behavior must be present on Windows, Linux, and macOS.
- The running state source remains `GET /api/agent/running`, polled every 2.5 seconds.
- A failed poll must preserve the current indicator state.
- The macOS tray image must remain a template image so it adapts to light and dark menu bars.
- Keep existing taskbar, Dock, and launcher badge behavior.
- Do not run `next build` during development.

---

### Task 1: Specify the native tray state transition with a failing regression test

**Files:**
- Modify: `desktop/main.test.mjs`

**Interfaces:**
- Consumes: `desktop/main.cjs` source text.
- Produces: regression assertions for `setRunningIndicator(isRunning)` updating `tray.setImage()` and `tray.setToolTip()` with separate running and idle values.

- [ ] **Step 1: Add a failing test that requires tray image and tooltip updates**

Append this test to `desktop/main.test.mjs`:

```js
test("updates the system-tray icon and tooltip when agent activity changes", () => {
  assert.match(source, /tray\.setImage\(isRunning \? createRunningTrayIcon\(\) : createTrayIcon\(\)\)/);
  assert.match(source, /tray\.setToolTip\(isRunning \? "Pi Web agent is running" : "Pi Web Desktop"\)/);
  assert.match(source, /function createRunningTrayIcon\(\)/);
  assert.match(source, /if \(process\.platform === "darwin"\) \{[\s\S]*?icon\.setTemplateImage\(true\);[\s\S]*?\}/);
});
```

- [ ] **Step 2: Run the focused test and verify it fails because tray state updates do not exist**

Run:

```bash
node --experimental-strip-types --test desktop/main.test.mjs
```

Expected: the new `updates the system-tray icon and tooltip when agent activity changes` test fails, reporting that `tray.setImage` and `createRunningTrayIcon` are absent.

- [ ] **Step 3: Commit the red test**

```bash
git add desktop/main.test.mjs
git commit -m "test: cover desktop tray running state"
```

### Task 2: Update the tray presentation from the existing running-state poll

**Files:**
- Modify: `desktop/main.cjs:29-73` (tray image helpers and `setRunningIndicator`)
- Modify: `desktop/main.cjs:125-171` (tray construction)

**Interfaces:**
- Consumes: `isRunning: boolean` from `refreshRunningIndicator()` and the module-level `tray: Electron.Tray | null`.
- Produces: `createTrayIcon(): Electron.NativeImage`, `createRunningTrayIcon(): Electron.NativeImage`, and an enhanced `setRunningIndicator(isRunning: boolean): void` that synchronizes native badges and the tray appearance.

- [ ] **Step 1: Add reusable idle and running tray-image helpers**

Replace the current standalone `getTrayIconPath()` helper with these helpers, keeping its existing path value:

```js
function getTrayIconPath() {
  return path.join(app.getAppPath(), "public", "icons", "icon-white-192.png");
}

function createTrayIcon() {
  const icon = nativeImage.createFromPath(getTrayIconPath()).resize(getTrayIconSize(process.platform));
  if (process.platform === "darwin") {
    icon.setTemplateImage(true);
  }
  return icon;
}

function createRunningTrayIcon() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><path d="M16 2.5a13.5 13.5 0 1 0 12.4 8.2" fill="none" stroke="black" stroke-width="4" stroke-linecap="round"/><circle cx="26.2" cy="7.3" r="3.1" fill="black"/></svg>`;
  const icon = nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`).resize(getTrayIconSize(process.platform));
  if (process.platform === "darwin") {
    icon.setTemplateImage(true);
  }
  return icon;
}
```

The running glyph is monochrome and uses an incomplete circular mark plus a leading dot, ensuring macOS can tint it as a template image and Windows/Linux can display it without theme-dependent contrast assumptions.

- [ ] **Step 2: Extend `setRunningIndicator` to synchronize the tray image and tooltip**

At the top of `setRunningIndicator`, after assigning `appIsRunning`, add:

```js
  if (tray) {
    tray.setImage(isRunning ? createRunningTrayIcon() : createTrayIcon());
    tray.setToolTip(isRunning ? "Pi Web agent is running" : "Pi Web Desktop");
  }
```

Leave the existing Windows, macOS, and Linux native-badge branches unchanged below it. This makes all three platforms update the tray icon from the same aggregate session state.

- [ ] **Step 3: Reuse the idle helper during tray creation**

Replace the icon initialization at the beginning of `createTray()`:

```js
  const icon = nativeImage.createFromPath(getTrayIconPath()).resize(getTrayIconSize(process.platform));
  if (process.platform === "darwin") {
    icon.setTemplateImage(true);
  }
```

with:

```js
  const icon = createTrayIcon();
```

The existing `tray.setToolTip("Pi Web Desktop")` remains the initial idle tooltip.

- [ ] **Step 4: Run the focused test and verify it passes**

Run:

```bash
node --experimental-strip-types --test desktop/main.test.mjs
```

Expected: all desktop main-process tests pass, including the new tray state test.

- [ ] **Step 5: Commit the implementation**

```bash
git add desktop/main.cjs desktop/main.test.mjs
git commit -m "feat: show agent activity in desktop tray"
```

### Task 3: Verify the full repository checks and inspect the final change

**Files:**
- Verify: `desktop/main.cjs`
- Verify: `desktop/main.test.mjs`

**Interfaces:**
- Consumes: completed tray state handling from Task 2.
- Produces: fresh automated evidence that the regression coverage and TypeScript checks pass.

- [ ] **Step 1: Run the focused desktop regression suite**

Run:

```bash
node --experimental-strip-types --test desktop/main.test.mjs
```

Expected: exit code 0 with every `desktop/main.test.mjs` test passing.

- [ ] **Step 2: Run the complete test suite**

Run:

```bash
npm test
```

Expected: exit code 0 with no test failures.

- [ ] **Step 3: Run the TypeScript check**

Run:

```bash
node_modules/.bin/tsc --noEmit
```

Expected: exit code 0 with no TypeScript diagnostics.

- [ ] **Step 4: Inspect the committed diff and working tree**

Run:

```bash
git status --short
git log --oneline -3
git show --check --stat HEAD
```

Expected: no unintended working-tree changes; the implementation commit contains only `desktop/main.cjs` and `desktop/main.test.mjs`.
