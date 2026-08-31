# Desktop Tray Running Indicator Design

## Goal

Show an active-state indicator directly on the Pi Web Desktop system-tray icon while at least one agent session is running. The behavior must work on Windows, Linux, and macOS.

## Scope

This change applies to the Electron desktop shell only. Existing taskbar, Dock, and launcher badges remain as complementary platform-specific signals.

## Design

`desktop/main.cjs` already polls `GET /api/agent/running` every 2.5 seconds. It will continue to be the sole source of running-session state, so no renderer process or API changes are required.

The desktop main process will keep two tray image variants:

- **Idle:** the current Pi Web tray icon.
- **Running:** an icon with a distinct activity mark.

When the polling response changes between idle and running, `setRunningIndicator()` will update both the platform-specific native badge and the tray presentation:

- `tray.setImage()` switches to the matching icon.
- `tray.setToolTip()` changes between `Pi Web Desktop` and `Pi Web agent is running`.

The update is guarded by the existing state-change check, avoiding redundant native calls during each poll.

## Platform behavior

- **Windows:** the tray icon changes while running; the existing taskbar overlay remains enabled.
- **Linux:** the tray icon changes while running; the existing launcher badge remains enabled where supported by the shell.
- **macOS:** the menu-bar tray icon changes while running and continues to use Electron template-image semantics so it remains legible in light and dark menu bars; the existing Dock badge remains enabled.

On application shutdown, polling is stopped and the indicator is reset to idle, restoring the tray icon and tooltip before the app exits.

## Error handling

Failed polling requests preserve the previous indicator state, matching the current behavior during embedded-server restarts. If a tray is unavailable, tray updates are skipped safely; native taskbar, Dock, and launcher indicators continue to be handled independently.

## Testing

Add static tests in `desktop/main.test.mjs` that verify:

1. Running and idle tray icon updates are expressed through `tray.setImage()`.
2. The tooltip identifies the running state.
3. Existing platform-native taskbar, Dock, and launcher badge behavior remains present.

The test suite and TypeScript typecheck will validate the change.
