import { test } from "node:test";
import assert from "node:assert/strict";
import { applyTransform, inferFrequency } from "../src/ingest/transforms";
import { surpriseTone } from "../src/lib/surprise";

const monthly = (pairs: Array<[string, number]>) => pairs.map(([date, value]) => ({ date, value }));

test("YoY uses the same month a year earlier, never a nearby month", () => {
  const pts = monthly([
    ["2024-01-01", 100], ["2024-03-01", 102],             // Feb 2024 missing
    ["2025-01-01", 103], ["2025-02-01", 104], ["2025-03-01", 105],
  ]);
  const out = applyTransform(pts, "pct_change_yoy", "monthly");
  assert.deepEqual(out.map((p) => p.date), ["2025-01-01", "2025-03-01"]); // no Feb 2025 value
  assert.ok(Math.abs(out[0].value - 3) < 1e-9);
});

test("MoM skips a gap instead of computing a two-month change", () => {
  const pts = monthly([["2025-01-01", 100], ["2025-03-01", 110], ["2025-04-01", 121]]);
  const out = applyTransform(pts, "pct_change_mom", "monthly");
  assert.deepEqual(out.map((p) => p.date), ["2025-04-01"]);
  assert.ok(Math.abs(out[0].value - 10) < 1e-9);
});

test("Quarterly QoQ requires the previous quarter", () => {
  const pts = monthly([["2024-10-01", 100], ["2025-01-01", 101], ["2025-07-01", 103]]);
  const out = applyTransform(pts, "pct_change", "quarterly");
  assert.deepEqual(out.map((p) => p.date), ["2025-01-01"]);
});

test("Diff on weekly data, frequency inferred", () => {
  const pts = monthly([["2025-01-04", 200], ["2025-01-11", 210], ["2025-01-25", 230]]);
  assert.equal(inferFrequency(pts), "weekly");
  const out = applyTransform(pts, "diff");
  assert.deepEqual(out.map((p) => [p.date, p.value]), [["2025-01-11", 10]]);
});

test("Surprise tone is read in rates terms", () => {
  assert.equal(surpriseTone(0.1, "us-cpi-mom"), "hawkish");
  assert.equal(surpriseTone(-0.1, "us-cpi-mom"), "dovish");
  assert.equal(surpriseTone(0.1, "us-unemployment"), "dovish");
  assert.equal(surpriseTone(-5, "us-initial-claims"), "hawkish");
  assert.equal(surpriseTone(0, "us-nfp"), "neutral");
});
