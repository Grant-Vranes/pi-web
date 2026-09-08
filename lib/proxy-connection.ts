import * as undici from "undici";
import {
  buildProxyUri,
  type NormalizedProxyConfig,
  type ProxyConfig,
} from "./proxy-settings";

/**
 * Build an undici Dispatcher that routes traffic through the given proxy
 * configuration, including Basic Auth for HTTP(S) proxies and username/password
 * for SOCKS5 proxies.
 *
 * Returns `null` when the config is not usable (disabled or incomplete), which
 * callers should treat as "no proxy".
 */
export function buildProxyDispatcher(
  config: Pick<ProxyConfig, "protocol" | "host" | "port" | "username" | "password">,
  options: { bodyTimeoutMs?: number; headersTimeoutMs?: number } = {},
): undici.Dispatcher | null {
  if (!config.host.trim() || config.port < 1 || config.port > 65535) return null;

  const proxyUri = buildProxyUri(config);
  if (!proxyUri) return null;

  if (config.protocol === "socks5") {
    return new undici.Socks5ProxyAgent(proxyUri, {
      bodyTimeout: options.bodyTimeoutMs,
      headersTimeout: options.headersTimeoutMs,
    });
  }

  return new undici.ProxyAgent({
    uri: proxyUri,
    requestTls: { rejectUnauthorized: true },
    bodyTimeout: options.bodyTimeoutMs,
    headersTimeout: options.headersTimeoutMs,
  });
}

export interface ProxyTestResult {
  ok: boolean;
  latencyMs?: number;
  status?: number;
  error?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Test connectivity through a proxy configuration by issuing a small request to
 * the configured (or default) test URL using a throwaway dispatcher. The passed
 * config does not have to be persisted yet — this is used by the settings form
 * before saving.
 */
export async function testProxyConnection(
  config: NormalizedProxyConfig | ProxyConfig,
  options: { timeoutMs?: number; testUrl?: string } = {},
): Promise<ProxyTestResult> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const rawConfig = config as ProxyConfig;
  const normalized: NormalizedProxyConfig = ("protocol" in rawConfig
    ? config
    : { ...config, protocol: "http" }) as NormalizedProxyConfig;

  const dispatcher = buildProxyDispatcher(normalized);
  if (!dispatcher) {
    return { ok: false, error: "Proxy configuration is incomplete (host and port required)." };
  }

  const testUrl = options.testUrl ?? normalized.testUrl ?? "https://api.taotoken.net/coding/v1";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();

  try {
    const response = await undici.request(testUrl, {
      method: "GET",
      dispatcher,
      signal: controller.signal,
      headers: { "user-agent": "pi-web-proxy-test" },
    });
    // Consume the body so the connection can be torn down cleanly.
    await response.body.arrayBuffer();
    const latencyMs = Date.now() - startedAt;
    return { ok: true, latencyMs, status: response.statusCode };
  } catch (error) {
    const aborted = controller.signal.aborted;
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      error: aborted ? `Request timed out after ${Math.round(timeoutMs / 1000)}s` : errorMessage(error),
    };
  } finally {
    clearTimeout(timeout);
    dispatcher.close?.().catch?.(() => {});
  }
}