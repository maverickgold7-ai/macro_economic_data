import { round } from "@/ingest/transforms";

/** Actual minus consensus when units look compatible. */
export function computeSurprise(
  actual: number | null | undefined,
  expected: number | null | undefined,
  unit: string
): number | null {
  if (
    actual == null ||
    expected == null ||
    !Number.isFinite(actual) ||
    !Number.isFinite(expected)
  ) {
    return null;
  }
  // Index level vs QoQ % (e.g. ECI total)
  if (unit === "index" && Math.abs(expected) < 25 && Math.abs(actual) > 40) return null;
  if (Math.abs(actual - expected) > 50_000) return null;
  return round(actual - expected);
}

/**
 * Rates-market reading of a surprise (actual − consensus) for a STIR desk.
 * hawkish = pushes policy-rate expectations up (stronger activity, hotter inflation,
 *           lower unemployment/claims); dovish = the opposite.
 * UI colours follow bond prices: hawkish = down (red), dovish = up (green).
 */
export function surpriseTone(
  surprise: number | null,
  metricId: string,
  _unit?: string
): "hawkish" | "dovish" | "neutral" {
  if (surprise == null || surprise === 0) return "neutral";
  const slackMeasure =
    metricId.includes("unemployment") ||
    metricId.includes("claims") ||
    metricId.includes("u6") ||
    metricId.includes("jobless");
  const hawkish = slackMeasure ? surprise < 0 : surprise > 0;
  return hawkish ? "hawkish" : "dovish";
}
