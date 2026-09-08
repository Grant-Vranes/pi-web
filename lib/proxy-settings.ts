import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "./atomic-file";

export type ProxyProtocol = "http" | "https" | "socks5";

export interface ProxyConfig {
  enabled: boolean;
  protocol: ProxyProtocol;
  host: string;
  port: number;
  username?: string;
  password?: string;
  /** Optional target URL used to test the proxy connection. Defaults to a public model gateway. */
  testUrl?: string;
  /** Optional host patterns to bypass the proxy (comma separated). Empty means proxy all. */
  noProxy?: string[];
}

type StoredProxyConfig = Record<string, unknown> & {
  version?: unknown;
  enabled?: unknown;
  protocol?: unknown;
  host?: unknown;
  port?: unknown;
  username?: unknown;
  password?: unknown;
  testUrl?: unknown;
  noProxy?: unknown;
};

const PROXY_PROTOCOLS: readonly ProxyProtocol[] = ["http", "https", "socks5"];
const DEFAULT_TEST_URL = "https://api.taotoken.net/coding/v1";

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function clampPort(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 65535) return 0;
  return value;
}

export interface NormalizedProxyConfig {
  enabled: boolean;
  protocol: ProxyProtocol;
  host: string;
  port: number;
  username?: string;
  password?: string;
  testUrl: string;
  noProxy: string[];
  /** True when the raw config had any invalid field that we silently dropped. */
  hadInvalidFields: boolean;
}

export function isProxyProtocol(value: unknown): value is ProxyProtocol {
  return typeof value === "string" && (PROXY_PROTOCOLS as readonly string[]).includes(value);
}

export function getProxyConfigPath(agentDir = getAgentDir()): string {
  return join(agentDir, "proxy.json");
}

function readStoredConfig(settingsPath: string): StoredProxyConfig {
  if (!existsSync(settingsPath)) return {};
  const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid proxy config: expected an object");
  }
  return parsed as StoredProxyConfig;
}

/**
 * Normalize raw stored fields into a fully-typed config, dropping invalid
 * values. Never throws on malformed persisted content — it fails closed.
 */
export function normalizeProxyConfig(stored: StoredProxyConfig): NormalizedProxyConfig {
  let hadInvalidFields = false;

  const protocol = isProxyProtocol(stored.protocol) ? stored.protocol : "http";
  if (stored.protocol !== undefined && stored.protocol !== protocol) hadInvalidFields = true;

  const hostRaw = asString(stored.host);
  if (stored.host !== undefined && hostRaw === undefined) hadInvalidFields = true;
  const host = (hostRaw ?? "").trim();

  const port = clampPort(typeof stored.port === "number" ? stored.port : 0);
  if (stored.port !== undefined && port === 0) hadInvalidFields = true;

  const username = asString(stored.username);
  const password = asString(stored.password);

  const testUrlRaw = asString(stored.testUrl);
  const testUrl = testUrlRaw && /^https?:\/\//i.test(testUrlRaw) ? testUrlRaw : DEFAULT_TEST_URL;

  const noProxyRaw = stored.noProxy;
  let noProxy: string[] = [];
  if (noProxyRaw !== undefined) {
    if (Array.isArray(noProxyRaw)) {
      noProxy = noProxyRaw
        .map((entry) => typeof entry === "string" ? entry.trim() : "")
        .filter((entry) => entry.length > 0);
    } else {
      hadInvalidFields = true;
    }
  }

  return {
    enabled: stored.enabled === true,
    protocol,
    host,
    port,
    username,
    password,
    testUrl,
    noProxy,
    hadInvalidFields,
  };
}

export function readProxyConfig(
  settingsPath = getProxyConfigPath(),
): NormalizedProxyConfig {
  try {
    return normalizeProxyConfig(readStoredConfig(settingsPath));
  } catch {
    return {
      enabled: false,
      protocol: "http",
      host: "",
      port: 0,
      testUrl: DEFAULT_TEST_URL,
      noProxy: [],
      hadInvalidFields: false,
    };
  }
}

export function writeProxyConfig(
  config: ProxyConfig,
  settingsPath = getProxyConfigPath(),
): NormalizedProxyConfig {
  mkdirSync(dirname(settingsPath), { recursive: true });
  const normalized = normalizeProxyConfig({
    version: 1,
    enabled: config.enabled,
    protocol: config.protocol,
    host: config.host,
    port: config.port,
    username: config.username,
    password: config.password,
    testUrl: config.testUrl,
    noProxy: config.noProxy,
  });
  writePrivateFileAtomicSync(settingsPath, JSON.stringify({
    version: 1,
    enabled: normalized.enabled,
    protocol: normalized.protocol,
    host: normalized.host,
    port: normalized.port,
    ...(normalized.username !== undefined ? { username: normalized.username } : {}),
    ...(normalized.password !== undefined ? { password: normalized.password } : {}),
    ...(normalized.testUrl !== DEFAULT_TEST_URL ? { testUrl: normalized.testUrl } : {}),
    ...(normalized.noProxy.length > 0 ? { noProxy: normalized.noProxy } : {}),
  }, null, 2));
  return normalized;
}

export function clearProxyConfig(
  settingsPath = getProxyConfigPath(),
): void {
  writeProxyConfig({
    enabled: false,
    protocol: "http",
    host: "",
    port: 0,
  }, settingsPath);
}

/**
 * Build the proxy URI used by undici. Credentials are URL-encoded so special
 * characters cannot break the URI (see undici proxy-agent.js which decodes and
 * base64-encodes them for the Proxy-Authorization header).
 */
export function buildProxyUri(config: Pick<ProxyConfig, "protocol" | "host" | "port" | "username" | "password">): string | null {
  if (!config.host.trim() || config.port < 1 || config.port > 65535) return null;
  const scheme = config.protocol === "socks5"
    ? "socks5"
    : config.protocol === "https"
      ? "https"
      : "http";
  const credentials = config.username !== undefined
    ? `${encodeURIComponent(config.username)}${config.password !== undefined ? `:${encodeURIComponent(config.password)}` : ""}@`
    : "";
  return `${scheme}://${credentials}${config.host.trim()}:${config.port}`;
}