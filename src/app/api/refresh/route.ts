import { NextRequest, NextResponse } from "next/server";
import { runIngest } from "@/ingest/pipeline";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const secret = process.env.REFRESH_SECRET ?? "dev-refresh-secret";
  const provided =
    req.headers.get("x-refresh-secret") ??
    req.nextUrl.searchParams.get("secret");
  if (provided !== secret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as { mode?: string };
  const mode = body.mode === "backfill" ? "backfill" : "refresh";
  const summary = await runIngest(mode);
  return NextResponse.json(summary);
}

export async function GET(req: NextRequest) {
  // Allow GET with secret for easy cron hooks
  const secret = process.env.REFRESH_SECRET ?? "dev-refresh-secret";
  const provided = req.nextUrl.searchParams.get("secret");
  if (provided !== secret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const mode =
    req.nextUrl.searchParams.get("mode") === "backfill" ? "backfill" : "refresh";
  const summary = await runIngest(mode);
  return NextResponse.json(summary);
}
