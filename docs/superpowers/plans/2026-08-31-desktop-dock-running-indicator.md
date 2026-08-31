# macOS Dock Running Indicator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the macOS Dock badge show a green breathing-light indicator while any Pi Web agent session is running, then clear it when idle.

**Architecture:** Keep the existing aggregate `/api/agent/running` poll and the existing 600ms tray animation timer as the sole activity source. Extend the timer lifecycle in `desktop/main.cjs` so macOS updates `app.dock.setBadge()` with two green circle glyph frames in sync with the tray frames, while Windows, Linux, and the native tray behavior remain intact.

**Tech Stack:** Electron main process, CommonJS, Node test runner, source-level assertions.

## Global Constraints

- Preserve Windows taskbar overlay behavior, Linux launcher badge behavior, and existing tray tooltip/icon behavior.
- Use `RUNNING_TRAY_FRAME_MS = 600` for the Dock breathing cadence; do not add a second activity poll or animation timer.
- Clear the macOS Dock badge immediately when running state ends.
- Do not run `next build` during development.

---

### Task 1: Add synchronized macOS Dock breathing badge

**Files:**
- Modify: `desktop/main.cjs:24-151`
- Modify: `desktop/main.test.mjs:13-20, 23-35`

**Interfaces:**
- Consumes: existing `setRunningIndicator(isRunning)`, `startRunningTrayAnimation()`, `stopRunningTrayAnimation()`, `RUNNING_TRAY_FRAME_MS`, and Electron `app.dock.setBadge()`.
- Produces: a macOS-only Dock badge that alternates between green glyph frames while the existing running animation is active and clears on stop.

- [ ] **Step 1: Write the failing source assertions**

Extend `desktop/main.test.mjs` with assertions that require:

```js
assert.match(source, /const RUNNING_DOCK_BADGE_FRAMES = \["🟢", "🟩"\]/);
assert.match(source, /function setRunningDockBadge\(frame\)/);
assert.match(source, /app\.dock\.setBadge\(RUNNING_DOCK_BADGE_FRAMES\[frame\]\)/);
assert.match(source, /setRunningDockBadge\(runningTrayFrame\)/);
assert.match(source, /app\.dock\.setBadge\(""\)/);
```

Update the existing macOS assertion from the old literal `app.dock.setBadge(isRunning ? "●" : "")` to assert the macOS branch still calls `setRunningDockBadge` on start and clears the badge through the stop path. Keep the Windows and Linux assertions unchanged.

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
node --test desktop/main.test.mjs
```

Expected: FAIL because `RUNNING_DOCK_BADGE_FRAMES`, `setRunningDockBadge`, and the synchronized calls do not yet exist.

- [ ] **Step 3: Implement the minimal Dock badge lifecycle**

In `desktop/main.cjs`, add immediately after `RUNNING_TRAY_FRAME_MS`:

```js
const RUNNING_DOCK_BADGE_FRAMES = ["🟢", "🟩"];
```

Add before `setRunningIndicator`:

```js
function setRunningDockBadge(frame) {
  if (process.platform === "darwin") {
    app.dock.setBadge(RUNNING_DOCK_BADGE_FRAMES[frame]);
  }
}
```

Make `startRunningTrayAnimation()` run when either a tray exists or the platform is macOS, so the Dock badge remains functional even if tray creation was unavailable. Keep the tray updates guarded, and set the initial frame through both surfaces:

```js
if (runningTrayFrameTimer || (!tray && process.platform !== "darwin")) return;
runningTrayFrame = 0;
if (tray) tray.setImage(createRunningTrayIcon(runningTrayFrame));
setRunningDockBadge(runningTrayFrame);
```

In the interval callback, after toggling `runningTrayFrame`, update the tray only when present and always update the Dock helper:

```js
if (tray) tray.setImage(createRunningTrayIcon(runningTrayFrame));
setRunningDockBadge(runningTrayFrame);
```

In `stopRunningTrayAnimation()`, guard the idle tray restore because tray creation may have failed, then clear the macOS Dock badge:

```js
if (tray) tray.setImage(createTrayIcon());
if (process.platform === "darwin") app.dock.setBadge("");
```

Remove the old direct `app.dock.setBadge(isRunning ? "●" : "")` call from the macOS branch of `setRunningIndicator`, leaving the branch responsible only for selecting platform-specific behavior while the shared lifecycle handles frame updates. Ensure `setRunningDockBadge` is a no-op on non-macOS so Windows and Linux never access `app.dock`.

- [ ] **Step 4: Run the focused test and verify it passes**

Run:

```bash
node --test desktop/main.test.mjs
```

Expected: PASS, including the existing tray PNG validation and platform badge assertions.

- [ ] **Step 5: Run project verification**

Run:

```bash
node_modules/.bin/tsc --noEmit
npm test -- --runInBand
```

Expected: TypeScript exits 0 and the repository test command exits 0. If the package test script does not accept `--runInBand`, run `npm test` without that option and report the exact result.

- [ ] **Step 6: Review the diff and commit**

Run:

```bash
git diff --check
git diff -- desktop/main.cjs desktop/main.test.mjs
git status --short
```

Confirm only the intended desktop source and test changes are present, then commit:

```bash
git add desktop/main.cjs desktop/main.test.mjs
git commit -m "feat: animate macOS dock activity badge"
```
