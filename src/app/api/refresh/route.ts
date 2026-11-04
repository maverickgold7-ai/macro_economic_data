import { NextRequest, NextResponse } from "next/server";
import { runIngest } from "@/ingest/pipeline";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Cron-friendly ingest trigger.
 * - REFRESH_SECRET must be set; there is no default secret.
 * - GET runs an incremental refresh only. A full backfill (which rewrites history)
 *   requires POST with {"mode": "backfill"} and the secret in the x-refresh-secret header.
 */
function authorise(req: NextRequest, allowQuery: boolean): NextResponse | null {
  const secret = process.env.REFRESH_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "REFRESH_SECRET is not configured" }, { status: 503 });
  }
  const provided =
    req.headers.get("x-refresh-secret") ??
    (allowQuery ? req.nextUrl.searchParams.get("secret") : null);
  if (provided !== secret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

async function run(mode: "backfill" | "refresh") {
  try {
    return NextResponse.json(await runIngest(mode));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const busy = message.includes("is still running");
    return NextResponse.json({ error: message }, { status: busy ? 409 : 500 });
  }
}

export async function POST(req: NextRequest) {
  const denied = authorise(req, false);
  if (denied) return denied;
  const body = (await req.json().catch(() => ({}))) as { mode?: string };
  return run(body.mode === "backfill" ? "backfill" : "refresh");
}

export async function GET(req: NextRequest) {
  const denied = authorise(req, true);
  if (denied) return denied;
  return run("refresh");
}
