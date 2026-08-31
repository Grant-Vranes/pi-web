# Desktop Tray Running Indicator Design

## Goal

Show an active-state indicator directly on the Pi Web Desktop system-tray icon while at least one agent session is running. The behavior must work on Windows, Linux, and macOS.

## Scope

This change applies to the Electron desktop shell only. Existing taskbar, Dock, and launcher badges remain as complementary platform-specific signals.

## Design

`desktop/main.cjs` already polls `GET /api/agent/running` every 2.5 seconds. It will continue to be the sole source of running-session state, so no renderer process or API changes are required.

The desktop main process will keep three packaged PNG tray-image variants:

- **Idle:** the current Pi Web tray icon.
- **Running, dim frame:** the original Pi icon with a dim green dot overlaid at its bottom-right corner.
- **Running, bright frame:** the original Pi icon with a bright green dot at the same position.

The running indicator represents **any active session**, including sessions in another project or backgrounded workspace.

When the polling response changes between idle and running, `setRunningIndicator()` will update the platform-specific native badge and tray presentation:

- Entering the running state starts a local 1.2-second two-frame timer that alternates the dim and bright PNGs, producing a restrained breathing effect.
- Leaving the running state clears that timer and restores the unmodified original Pi tray icon immediately.
- `tray.setToolTip()` changes between `Pi Web Desktop` and `Pi Web agent is running`.

The existing state-change check continues to avoid redundant native calls during each poll; the local animation timer only runs while a session is active.

## Platform behavior

- **Windows:** the tray icon retains the Pi mark and displays the green breathing dot; the existing taskbar overlay remains enabled.
- **Linux:** the tray icon retains the Pi mark and displays the green breathing dot; the existing launcher badge remains enabled where supported by the shell.
- **macOS:** the menu-bar tray icon retains the Pi mark and displays the bottom-right breathing mark; all frames continue to use Electron template-image semantics so they remain legible in light and dark menu bars; the existing Dock badge remains enabled.

On application shutdown, polling is stopped, the animation timer is cleared, and the indicator resets to idle before the app exits.

## Error handling

Failed polling requests preserve the previous indicator state, matching the current behavior during embedded-server restarts. If a tray is unavailable, tray updates are skipped safely; native taskbar, Dock, and launcher indicators continue to be handled independently.

## Testing

Add static tests in `desktop/main.test.mjs` that verify:

1. Running and idle tray icon updates are expressed through `tray.setImage()`.
2. Entering and leaving the running state starts and clears the local breathing-frame timer.
3. The tooltip identifies the running state.
4. Both running PNGs load as non-empty Electron `NativeImage` instances.
5. Existing platform-native taskbar, Dock, and launcher badge behavior remains present.

The targeted desktop tests, Electron image probes, and TypeScript typecheck will validate the change.
