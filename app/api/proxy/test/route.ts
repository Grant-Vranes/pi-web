import { NextResponse } from "next/server";
import { testProxyConnection } from "@/lib/proxy-connection";
import {
  normalizeProxyConfig,
  type NormalizedProxyConfig,
} from "@/lib/proxy-settings";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

const TEST_TIMEOUT_MS = 15_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ ok: false, error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ ok: false, error: "Content-Type must be application/json" }, { status: 415 });
  }

  try {
    const body: unknown = await req.json();
    if (!isRecord(body)) {
      return NextResponse.json({ ok: false, error: "Invalid proxy config" }, { status: 400 });
    }

    // Accept a full proxy config (with an optional testUrl override). It does
    // not need to be saved yet — the settings form tests before persisting.
    const normalized: NormalizedProxyConfig = normalizeProxyConfig(body);
    const testUrl = typeof body.testUrl === "string" && /^https?:\/\//i.test(body.testUrl)
      ? body.testUrl
      : undefined;

    const result = await testProxyConnection(normalized, {
      timeoutMs: TEST_TIMEOUT_MS,
      testUrl,
    });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}