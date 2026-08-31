# Desktop Tray Breathing Indicator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve the Pi tray icon and show a bottom-right breathing session indicator whenever any agent session is running.

**Architecture:** The existing 2.5-second `/api/agent/running` poll remains the sole aggregate-state source. The Electron main process owns a 600 ms two-frame animation timer while active, and stops it to restore the idle Pi icon as soon as no sessions run. Both frames are packaged PNGs, loaded through `nativeImage.createFromPath()` to avoid the empty SVG `NativeImage` regression.

**Tech Stack:** Electron `Tray` and `nativeImage`, packaged PNG assets, Node.js built-in test runner.

## Global Constraints

- Indicator represents any active session across all projects and background workspaces.
- The original Pi icon remains visible behind a bottom-right status dot.
- Windows and Linux use a green breathing dot; macOS uses a template-image system-color breathing dot for light/dark menu-bar legibility.
- Running frames are switched every 600 ms and only while a session is active.
- Both frames must be valid packaged PNGs loaded with `nativeImage.createFromPath()`.
- Preserve the existing Windows taskbar, macOS Dock, and Linux launcher badges.
- Do not run `next build`.

---

### Task 1: Add failing regression coverage for composite breathing frames

**Files:**
- Modify: `desktop/main.test.mjs`

**Interfaces:**
- Consumes: desktop main-process source text.
- Produces: assertions requiring two path-based running frames, a 600 ms frame timer, and cleanup when inactive.

- [ ] **Step 1: Write a failing test**

Replace the running-tray test body with assertions for `RUNNING_TRAY_FRAME_MS = 600`, `getRunningTrayIconPath(frame)`, `startRunningTrayAnimation()`, `stopRunningTrayAnimation()`, and `clearInterval(runningTrayFrameTimer)`.

- [ ] **Step 2: Verify red**

Run:

```bash
/Users/akio/.nvm/versions/node/v22.22.0/bin/node --experimental-strip-types --test desktop/main.test.mjs
```

Expected: the tray test fails because the timer and two-frame path are absent.

### Task 2: Package original-icon breathing frames and implement timer lifecycle

**Files:**
- Create: `public/icons/tray-running-dim.png`
- Create: `public/icons/tray-running-bright.png`
- Modify: `desktop/main.cjs`
- Modify: `desktop/main.test.mjs`

**Interfaces:**
- Consumes: `setRunningIndicator(isRunning)`, module-level `tray`, and the existing aggregate running poll.
- Produces: path-based dim/bright image frames and `startRunningTrayAnimation()` / `stopRunningTrayAnimation()` lifecycle helpers.

- [ ] **Step 1: Create PNG assets**

Generate two transparent PNGs from the original Pi icon. Each preserves the icon and adds a bottom-right circular dot with a separating outline. The dim asset uses lower opacity and the bright asset uses full opacity. Keep the asset generation outside runtime code, then commit only the resulting PNGs.

- [ ] **Step 2: Add timer state and frame loading**

Add:

```js
const RUNNING_TRAY_FRAME_MS = 600;
let runningTrayFrameTimer = null;
let runningTrayFrame = 0;
```

Use a path helper selecting `tray-running-dim.png` for frame `0` and `tray-running-bright.png` for frame `1`. `createRunningTrayIcon(frame)` must use `nativeImage.createFromPath()` and preserve existing macOS `setTemplateImage(true)` behavior.

- [ ] **Step 3: Add animation helpers**

`startRunningTrayAnimation()` must set frame `0` immediately, then alternate frames every `RUNNING_TRAY_FRAME_MS`; it must be a no-op if already running. `stopRunningTrayAnimation()` must clear and null the timer, reset the frame index, and restore `createTrayIcon()`.

- [ ] **Step 4: Connect lifecycle to aggregate state**

In `setRunningIndicator(isRunning)`, call `startRunningTrayAnimation()` on true and `stopRunningTrayAnimation()` on false. Leave tooltip and all existing platform-specific badges intact.

- [ ] **Step 5: Verify green**

Run the focused test, Electron native-image probe for both PNGs, TypeScript check, and changed-file lint.

### Task 3: Commit and verify regression prevention

**Files:**
- Verify: `desktop/main.cjs`
- Verify: `desktop/main.test.mjs`
- Verify: `public/icons/tray-running-dim.png`
- Verify: `public/icons/tray-running-bright.png`

- [ ] **Step 1: Commit**

```bash
git add desktop/main.cjs desktop/main.test.mjs public/icons/tray-running-dim.png public/icons/tray-running-bright.png docs/superpowers/specs/2026-08-31-desktop-tray-running-indicator-design.md docs/superpowers/plans/2026-08-31-desktop-tray-running-indicator.md
git commit -m "feat: animate desktop tray activity"
```

- [ ] **Step 2: Run final checks**

```bash
/Users/akio/.nvm/versions/node/v22.22.0/bin/node --experimental-strip-types --test desktop/main.test.mjs
node_modules/.bin/tsc --noEmit
node_modules/.bin/eslint desktop/main.cjs desktop/main.test.mjs
git diff --check
git status --short
```

Expected: focused tests, typecheck, and changed-file lint pass; working tree is clean.
