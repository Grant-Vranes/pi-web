# Centralize Port Configuration Design

## Goal

Make Pi Web's port configurable from one project-local configuration file for development, Electron desktop development, and the published `pi-web` CLI. Keep the current `30141` default and retain command-line/environment overrides for one-off launches.

## Configuration contract

- Add a committed `.env.example` with `PORT=30141` and commented hostname guidance.
- Developers copy it to `.env.local`, which remains ignored by Git, and change `PORT` there.
- `.env.local` is the single persistent configuration location. It is optional: absent configuration preserves the `30141` default.
- Launch precedence is, from highest to lowest: explicit CLI `--port`/`-p`; `PORT` already present in the process environment (including an environment file loaded for that process); fallback default `30141`.
- `PI_WEB_HOSTNAME` keeps its existing behavior. The implementation does not broaden bind-address behavior or alter authentication/security checks.

## Startup design

### Development server

Replace hard-coded `-p 30141` package scripts with a small Node launcher. The launcher loads the project `.env.local` when it exists, validates the port using the same rules as the CLI, and starts Next with the resolved hostname and port.

`dev` and `dev:lan` retain their current host defaults (`127.0.0.1` and `0.0.0.0`). An explicitly exported `PORT` remains usable without editing files.

### Desktop development

Replace the hard-coded `wait-on tcp:127.0.0.1:30141` command with a launcher that resolves the same port before starting both processes. It passes that resolved port to the development server and Electron so Electron probes and opens the same address.

### Published CLI and packaged Electron

The CLI's existing parser remains the canonical place for port validation and precedence. It additionally loads the project-local `.env.local` before resolving launch options, without overwriting variables the caller explicitly supplied.

Electron's runtime gets its port through the same launch-option/config helper rather than its own `process.env.PORT || 30141` expression. When Electron starts its embedded server, it forwards the resolved port. This keeps port probing, server startup, and `BrowserWindow.loadURL()` aligned.

## Files and responsibilities

- `bin/pi-web-options.js`: own default port, validation, precedence, and environment-file loading helpers shared by Node launch paths.
- New development launcher(s) under `bin/`: resolve config and coordinate Next / Electron development processes without shell interpolation.
- `package.json`: delegate `dev`, `dev:lan`, and `desktop:dev` to the launcher(s); retain normal production scripts with no literal port.
- `desktop/main.cjs`: obtain its resolved port from the shared helper.
- `.env.example`: document the persistent port setting.
- `README*.md` and `AGENTS.md`: replace fixed development-port wording with the default and document `.env.local` setup.
- Tests around option/config parsing and desktop launch helpers: cover default configuration, `.env.local` loading, override precedence, invalid ports, and propagation to Electron development startup.

## Error handling and security

- A malformed configured port fails before starting child processes, using the existing `0`–`65535` validation semantics.
- Environment files are parsed as plain key/value data; no shell evaluation is performed.
- Only the recognized launch settings are consumed. Existing project-command environment sanitization continues to remove `PORT` for agent-launched project commands.
- Loopback/LAN warnings and password requirements are unchanged.

## Verification

1. Automated tests prove defaults, `.env.local` values, explicit `PORT`, and `--port` priority.
2. Automated tests prove malformed ports fail safely and do not permit argument injection.
3. Typecheck and lint pass.
4. Manually start `npm run dev` after setting a non-default `.env.local` port and confirm it listens on that port.
5. Manually start `npm run desktop:dev` with the same setting and confirm Electron loads the matching server.
