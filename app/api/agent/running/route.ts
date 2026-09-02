import { NextResponse } from "next/server";
import {
  getCompletionNotificationSuppressedRpcSessionIds,
  getRunningRpcSessionDetails,
  getRunningRpcSessionIds,
} from "@/lib/rpc-manager";

export const dynamic = "force-dynamic";

// GET /api/agent/running - Lightweight snapshot for visible-tab polling.
export async function GET() {
  return NextResponse.json(
    {
      runningSessionIds: getRunningRpcSessionIds(),
      // Per-session model/cwd/state for running sessions, used by project
      // indicator tooltips. Cheap to compute — read from in-memory wrappers.
      runningSessionDetails: getRunningRpcSessionDetails(),
      completionNotificationSuppressedSessionIds: getCompletionNotificationSuppressedRpcSessionIds(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
