import { NextResponse } from "next/server";
import {
  clearProxyConfig,
  readProxyConfig,
  writeProxyConfig,
  type NormalizedProxyConfig,
  type ProxyConfig,
  type ProxyProtocol,
} from "@/lib/proxy-settings";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

export interface ProxyConfigResponse extends NormalizedProxyConfig {
  passwordSet: boolean;
}

function toResponse(config: NormalizedProxyConfig): ProxyConfigResponse {
  return {
    enabled: config.enabled,
    protocol: config.protocol,
    host: config.host,
    port: config.port,
    username: config.username,
    // Never return the plaintext password.
    passwordSet: config.password !== undefined,
    testUrl: config.testUrl,
    noProxy: config.noProxy,
    hadInvalidFields: config.hadInvalidFields,
  };
}

export async function GET() {
  try {
    return NextResponse.json(toResponse(readProxyConfig()));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asOptionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  try {
    const body: unknown = await req.json();
    if (!isRecord(body)) {
      return NextResponse.json({ error: "Invalid proxy config" }, { status: 400 });
    }

    const protocol = body.protocol as ProxyProtocol;
    if (protocol !== "http" && protocol !== "https" && protocol !== "socks5") {
      return NextResponse.json({ error: "protocol must be http, https or socks5" }, { status: 400 });
    }
    if (typeof body.host !== "string" || body.host.trim().length === 0) {
      return NextResponse.json({ error: "host is required" }, { status: 400 });
    }
    if (typeof body.port !== "number" || !Number.isInteger(body.port) || body.port < 1 || body.port > 65535) {
      return NextResponse.json({ error: "port must be an integer between 1 and 65535" }, { status: 400 });
    }
    if (body.testUrl !== undefined && body.testUrl !== null && typeof body.testUrl !== "string") {
      return NextResponse.json({ error: "testUrl must be a string if provided" }, { status: 400 });
    }

    // Password handling: an absent/empty password means "keep the stored one".
    // A non-empty value replaces it; an explicit "remove" is not supported here.
    const stored = readProxyConfig();
    const incomingPassword = asOptionalString(body.password);
    const password = incomingPassword === undefined ? stored.password : incomingPassword;

    const config: ProxyConfig = {
      enabled: body.enabled === true,
      protocol,
      host: body.host.trim(),
      port: body.port,
      username: asOptionalString(body.username),
      ...(password !== undefined ? { password } : {}),
      ...(asOptionalString(body.testUrl) ? { testUrl: asOptionalString(body.testUrl)! } : {}),
      ...(Array.isArray(body.noProxy)
        ? { noProxy: body.noProxy.filter((value): value is string => typeof value === "string" && value.length > 0) }
        : {}),
    };

    const normalized = writeProxyConfig(config);
    return NextResponse.json({ ok: true, config: toResponse(normalized) });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

export async function DELETE(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  clearProxyConfig();
  return NextResponse.json({ ok: true });
}