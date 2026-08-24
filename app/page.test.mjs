import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const pageSource = await readFile(new URL("./page.tsx", import.meta.url), "utf8");
const clientShellSource = await readFile(new URL("../components/ClientAppShell.tsx", import.meta.url), "utf8").catch(() => "");

test("home page mounts the interactive app shell client-side only", () => {
  assert.match(pageSource, /import \{ ClientAppShell \} from "@\/components\/ClientAppShell"/);
  assert.doesNotMatch(pageSource, /import \{ AppShell \} from "@\/components\/AppShell"/);
  assert.match(pageSource, /<ClientAppShell \/>/);
  assert.match(clientShellSource, /dynamic\(\s*\(\) => import\("\.\/AppShell"\)[\s\S]*?ssr:\s*false/);
  assert.match(clientShellSource, /<I18nProvider>[\s\S]*?<AppShellNoSsr \/>[\s\S]*?<\/I18nProvider>/);
});
