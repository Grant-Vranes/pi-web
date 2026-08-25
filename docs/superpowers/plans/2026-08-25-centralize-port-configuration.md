# Centralize Port Configuration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let one project-local `.env.local` setting configure the Pi Web port consistently for development, Electron, and the CLI while preserving safe temporary overrides.

**Architecture:** Extend `bin/pi-web-options.js` into the single Node launch-configuration boundary: it parses `.env.local` as data, merges it beneath caller-provided environment variables, and retains CLI precedence. Small Node launchers will invoke Next and coordinate desktop development using that resolved configuration; Electron will use the same resolver for its server, probe, and browser URL.

**Tech Stack:** Node.js 22.19+ CommonJS, Node built-in `node:util` `parseEnv`, Next.js CLI, Electron, Node test runner.

## Global Constraints

- Node.js must remain `>=22.19.0`; use Node built-ins and do not add a dotenv dependency.
- The default port remains `30141`; valid ports are integers in the inclusive range `0`–`65535`.
- Precedence is CLI `--port`/`-p`, then caller environment `PORT`, then `.env.local`, then default.
- Parse configuration as data only; never shell-source or evaluate `.env.local`.
- Keep `PI_WEB_HOSTNAME`, loopback/LAN warning behavior, password requirements, and project-command `PORT` sanitization unchanged.
- Do not run `next build` during development.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `bin/pi-web-options.js` | Validate ports; read a project-local `.env.local`; merge its values below explicit process environment; parse final launch options. |
| `bin/start-dev.js` | Start Next development mode using the shared resolved port and a supplied fixed development hostname. |
| `bin/start-desktop-dev.js` | Start the development server, wait for its dynamically configured loopback port, then start Electron with matching environment and clean up both children. |
| `desktop/main.cjs` | Resolve Electron's port through the shared parser so URL creation, reachability checks, and embedded-server launch use one port. |
| `lib/pi-web-options.test.mjs` | Regression tests for defaults, `.env.local`, precedence, malformed values, and unchanged host/no-open behavior. |
| `lib/desktop-runtime-helpers.test.mjs` | Test the extracted readiness polling helper without launching Electron. |
| `desktop/runtime-helpers.cjs` | Host the extracted testable `waitForPort` helper used by the desktop development launcher and Electron. |
| `.env.example` | Committed template documenting `PORT=30141` and optional hostname configuration. |
| `package.json` | Delegate development and desktop-development scripts to the Node launchers; remove literal development port commands. |
| `README.md`, `README.zh-CN.md`, `README.ja.md`, `README.ru.md`, `AGENTS.md` | Document `.env.local` as the persistent port setting and describe `30141` as the fallback default. |

### Task 1: Centralize launch configuration and cover precedence

**Files:**
- Modify: `bin/pi-web-options.js`
- Modify: `lib/pi-web-options.test.mjs`

**Interfaces:**
- Produces: `readProjectEnv(cwd?: string): Record<string, string>`.
- Produces: `parseLaunchOptions(args?: string[], env?: Record<string, string | undefined>, options?: { cwd?: string }): { port: string; hostname: string; openBrowser: boolean }`.
- Consumes: Node `node:fs`, `node:path`, and `node:util.parseEnv`; later launchers call `parseLaunchOptions` instead of reading `PORT` directly.

- [ ] **Step 1: Write failing tests for file loading and precedence**

  In `lib/pi-web-options.test.mjs`, add temporary-directory helpers and tests that create `.env.local` files. Use this exact shape so tests do not use the repository's real environment:

  ```js
  import fs from "node:fs";
  import os from "node:os";
  import path from "node:path";

  function withProjectEnv(contents, callback) {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-options-"));
    try {
      fs.writeFileSync(path.join(cwd, ".env.local"), contents);
      return callback(cwd);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }

  test("loads PORT from a project-local .env.local", () => {
    withProjectEnv("PORT=43141\n", (cwd) => {
      assert.equal(parseLaunchOptions([], {}, { cwd }).port, "43141");
    });
  });

  test("prefers caller environment and CLI port over .env.local", () => {
    withProjectEnv("PORT=43141\n", (cwd) => {
      assert.equal(parseLaunchOptions([], { PORT: "44141" }, { cwd }).port, "44141");
      assert.equal(parseLaunchOptions(["--port", "45141"], { PORT: "44141" }, { cwd }).port, "45141");
    });
  });

  test("rejects an invalid port supplied by .env.local", () => {
    withProjectEnv("PORT=invalid\n", (cwd) => {
      assert.throws(() => parseLaunchOptions([], {}, { cwd }), /Port must be a non-negative integer/);
    });
  });
  ```

- [ ] **Step 2: Run the focused tests to verify the new cases fail**

  Run:

  ```bash
  node --experimental-strip-types --test lib/pi-web-options.test.mjs
  ```

  Expected: FAIL because `parseLaunchOptions` does not yet accept a third `cwd` option and does not read `.env.local`.

- [ ] **Step 3: Implement safe project-environment loading and merging**

  In `bin/pi-web-options.js`, add `fs`, `path`, and `parseEnv` imports. Add a reader which returns `{}` when the file is absent and uses Node's parser (not a shell):

  ```js
  function readProjectEnv(cwd = process.cwd()) {
    const envPath = path.join(cwd, ".env.local");
    if (!fs.existsSync(envPath)) {
      return {};
    }
    return parseEnv(fs.readFileSync(envPath, "utf8"));
  }
  ```

  Change the parser signature and resolve environment values before parsing options:

  ```js
  function parseLaunchOptions(args = process.argv.slice(2), env = process.env, { cwd = process.cwd() } = {}) {
    const resolvedEnv = { ...readProjectEnv(cwd), ...env };
    const { values: cliArgs } = parseArgs({
      args,
      options: {
        port: { type: "string", short: "p" },
        hostname: { type: "string", short: "H" },
        "no-open": { type: "boolean" },
      },
      strict: false,
    });
    return {
      port: normalizePort(cliArgs.port ?? resolvedEnv.PORT ?? "30141"),
      hostname: cliArgs.hostname ?? resolvedEnv.PI_WEB_HOSTNAME ?? "127.0.0.1",
      openBrowser: !cliArgs["no-open"] && !isEnabled(resolvedEnv.PI_WEB_NO_OPEN),
    };
  }

  module.exports = { parseLaunchOptions, readProjectEnv };
  ```

  Do not mutate `process.env`; the return value is the resolved configuration passed explicitly to child processes.

- [ ] **Step 4: Run focused tests to verify they pass**

  Run:

  ```bash
  node --experimental-strip-types --test lib/pi-web-options.test.mjs
  ```

  Expected: PASS, including existing injection and hostname tests plus the new `.env.local` coverage.

- [ ] **Step 5: Commit the configuration boundary**

  ```bash
  git add bin/pi-web-options.js lib/pi-web-options.test.mjs
  git commit -m "feat: load launch port from project env"
  ```

### Task 2: Replace hard-coded development and Electron ports with shared launchers

**Files:**
- Create: `bin/start-dev.js`
- Create: `bin/start-desktop-dev.js`
- Modify: `desktop/runtime-helpers.cjs`
- Modify: `desktop/main.cjs`
- Modify: `package.json`
- Modify: `lib/desktop-runtime-helpers.test.mjs`

**Interfaces:**
- Consumes: `parseLaunchOptions(args, env, { cwd })` from `bin/pi-web-options.js`.
- Produces: `waitForPort(host: string, port: number, timeoutMs?: number): Promise<void>` from `desktop/runtime-helpers.cjs`.
- `bin/start-dev.js` accepts `--hostname <host>` and starts Next with shared resolved options.
- `bin/start-desktop-dev.js` starts the dev launcher, calls `waitForPort("127.0.0.1", Number(port))`, and starts Electron with `PI_WEB_DESKTOP_DEV=1` and the resolved `PORT`.

- [ ] **Step 1: Write a failing readiness-helper test**

  Add this test to `lib/desktop-runtime-helpers.test.mjs` and import `waitForPort` beside the existing helpers:

  ```js
  test("rejects when a port does not become reachable before the timeout", async () => {
    await assert.rejects(
      waitForPort("127.0.0.1", 1, 20),
      /Timed out waiting for 127\.0\.0\.1:1/,
    );
  });
  ```

- [ ] **Step 2: Run the readiness-helper test and verify it fails**

  Run:

  ```bash
  node --experimental-strip-types --test lib/desktop-runtime-helpers.test.mjs
  ```

  Expected: FAIL because `waitForPort` is not exported from `desktop/runtime-helpers.cjs`.

- [ ] **Step 3: Extract and export the shared readiness helper**

  Move the existing `waitForPort` implementation from `desktop/main.cjs` unchanged into `desktop/runtime-helpers.cjs`, then export it:

  ```js
  module.exports = {
    getTrayIconSize,
    shouldLaunchEmbeddedServer,
    waitForPort,
  };
  ```

  In `desktop/main.cjs`, import it with the existing helper destructuring and delete the local duplicate. This preserves current retry timing and error text.

- [ ] **Step 4: Add `bin/start-dev.js`**

  Create a CommonJS executable which parses its `--hostname` argument using the shared parser, then invokes Next without a shell. Resolve Next as `bin/pi-web.js` already does. Its core must be:

  ```js
  const { spawn } = require("child_process");
  const { parseLaunchOptions } = require("./pi-web-options");

  const { port, hostname } = parseLaunchOptions();
  const child = spawn(process.execPath, [nextBin, "dev", "-H", hostname, "-p", port], {
    cwd: pkgDir,
    stdio: "inherit",
    env: { ...process.env, PORT: port, PI_WEB_HOSTNAME: hostname },
  });
  child.on("exit", (code, signal) => process.exitCode = code ?? (signal ? 1 : 0));
  ```

  Resolve `nextBin` with the same `require.resolve("next/dist/bin/next", { paths: [pkgDir] })` / `next/package.json` fallback used in `bin/pi-web.js`. Set `process.exitCode` rather than forcibly exiting so inherited signals can finish cleanly.

- [ ] **Step 5: Add `bin/start-desktop-dev.js`**

  Create a CommonJS coordinator which resolves `const { port } = parseLaunchOptions(["--hostname", "127.0.0.1"]);`, spawns `process.execPath` with `[path.join(__dirname, "start-dev.js"), "--hostname", "127.0.0.1"]`, and passes `PORT: port` into that child environment. After `await waitForPort("127.0.0.1", Number(port))`, spawn Electron through its resolved binary with `[path.join(pkgDir, "desktop", "main.cjs")]` and this environment:

  ```js
  {
    ...process.env,
    PORT: port,
    PI_WEB_HOSTNAME: "127.0.0.1",
    PI_WEB_DESKTOP_DEV: "1",
  }
  ```

  Attach `SIGINT` and `SIGTERM` handlers which send that signal to both live children. When either child exits, set the exit code and terminate the other child, preventing orphaned Next or Electron processes. On readiness failure, print the error, terminate the dev child, and set `process.exitCode = 1`.

- [ ] **Step 6: Make Electron resolve the same port**

  In `desktop/main.cjs`, import `parseLaunchOptions` from `../bin/pi-web-options`. Replace the literal default with:

  ```js
  const HOST = "127.0.0.1";
  const { port: configuredPort } = parseLaunchOptions(["--hostname", HOST]);
  const PORT = Number(configuredPort);
  ```

  Keep `HOST` fixed for the desktop wrapper. This allows `PORT`/`.env.local` to select the port without allowing a configuration hostname to make the desktop wrapper non-loopback.

- [ ] **Step 7: Wire scripts to the launchers**

  Replace the four development/desktop script values in `package.json` with:

  ```json
  "dev": "node bin/start-dev.js --hostname 127.0.0.1",
  "dev:lan": "node bin/start-dev.js --hostname 0.0.0.0",
  "desktop:dev": "node bin/start-desktop-dev.js",
  "desktop:start": "cross-env PI_WEB_DESKTOP_DEV=0 electron desktop/main.cjs"
  ```

  Leave `start` and `start:lan` unchanged in this task: they remain explicit production Next scripts and are superseded for published usage by `bin/pi-web.js`. If project requirements demand them to respect `.env.local` too, change them in a follow-up only after confirming Next CLI environment loading semantics.

- [ ] **Step 8: Run focused runtime and option tests**

  Run:

  ```bash
  node --experimental-strip-types --test lib/pi-web-options.test.mjs lib/desktop-runtime-helpers.test.mjs
  ```

  Expected: PASS.

- [ ] **Step 9: Manually verify the non-default development port**

  Run, then stop it with `Ctrl+C` after the ready message:

  ```bash
  printf 'PORT=43141\n' > .env.local
  npm run dev
  ```

  Expected: Next reports `http://127.0.0.1:43141`. Remove the temporary local file afterward:

  ```bash
  rm .env.local
  ```

- [ ] **Step 10: Commit shared launch behavior**

  ```bash
  git add bin/start-dev.js bin/start-desktop-dev.js desktop/runtime-helpers.cjs desktop/main.cjs package.json lib/desktop-runtime-helpers.test.mjs
  git commit -m "feat: share configured port across dev and desktop"
  ```

### Task 3: Add the user-facing configuration template and documentation

**Files:**
- Create: `.env.example`
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `README.ja.md`
- Modify: `README.ru.md`
- Modify: `AGENTS.md`

**Interfaces:**
- Consumes: the `.env.local` behavior implemented in Tasks 1–2.
- Produces: a copyable configuration template and consistent contributor/user instructions.

- [ ] **Step 1: Create the configuration template**

  Create `.env.example` with exactly:

  ```dotenv
  # Copy this file to .env.local and change the port for this checkout.
  PORT=30141

  # Optional: override the default CLI bind address (127.0.0.1).
  # PI_WEB_HOSTNAME=127.0.0.1
  ```

- [ ] **Step 2: Update English documentation**

  In `README.md`, add this configuration example immediately after the configuration table:

  ```bash
  cp .env.example .env.local
  # Edit .env.local, for example: PORT=8080
  ```

  State that `.env.local` provides project-local defaults for `npm run dev`, `npm run desktop:dev`, and `pi-web` run from that directory; it is ignored by Git; command-line options and already exported environment variables override it. Change development wording from a fixed URL to “defaults to `http://127.0.0.1:30141` and uses `PORT` from `.env.local` when configured.”

- [ ] **Step 3: Update localized user documentation**

  Make the equivalent, locale-appropriate additions in `README.zh-CN.md`, `README.ja.md`, and `README.ru.md`. Preserve each document's existing table of CLI/environment configuration and replace only its fixed development URL statement with default-plus-override wording. The commands remain the same as the English example because they are shell commands.

- [ ] **Step 4: Update contributor guidance**

  Replace the top-level `AGENTS.md` quick-start comment `# port 30141` with `# default port 30141; override in .env.local`. Do not alter its prohibition on `next build` during normal development.

- [ ] **Step 5: Run documentation/configuration regression checks**

  Run:

  ```bash
  git check-ignore .env.local
  test ! -e .env.local
  grep -n 'PORT=30141' .env.example
  node --experimental-strip-types --test lib/pi-web-options.test.mjs lib/desktop-runtime-helpers.test.mjs
  ```

  Expected: `.env.local` is reported as ignored; no temporary `.env.local` remains; the template contains `PORT=30141`; all focused tests pass.

- [ ] **Step 6: Commit template and documentation**

  ```bash
  git add .env.example README.md README.zh-CN.md README.ja.md README.ru.md AGENTS.md
  git commit -m "docs: document project-local port configuration"
  ```

### Task 4: Run the complete verification suite

**Files:**
- Verify only; no source edits expected.

**Interfaces:**
- Consumes: all implementation and documentation changes from Tasks 1–3.
- Produces: evidence that source, type, lint, and test checks remain valid.

- [ ] **Step 1: Run the full automated test suite**

  Run:

  ```bash
  npm test
  ```

  Expected: all Node test files pass.

- [ ] **Step 2: Run static checks**

  Run:

  ```bash
  node_modules/.bin/tsc --noEmit
  npm run lint
  ```

  Expected: both commands exit with status `0`.

- [ ] **Step 3: Check final diff and repository state**

  Run:

  ```bash
  git diff HEAD~3..HEAD --check
  git status --short
  ```

  Expected: no whitespace errors and an empty status. Do not run `next build`.

- [ ] **Step 4: Commit any verification-only correction if needed**

  If a verification command required a source correction, stage the corrected tracked files and commit them with:

  ```bash
  git add -u
git commit -m "fix: satisfy port configuration checks"
  ```

  If no correction was needed, do not create an empty commit.
