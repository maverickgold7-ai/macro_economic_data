import { test } from "node:test";
import assert from "node:assert/strict";
import { annualized3mFromMom, movingAverage3, printsPer3m } from "../src/lib/smoothing";

test("3 months annualized: monthly compounds 3 MoM prints, quarterly uses one QoQ print", () => {
  const monthly = annualized3mFromMom([0.2, 0.3, 0.25], { periodsPerYear: 12 });
  const expected = (Math.pow(1.002 * 1.003 * 1.0025, 4) - 1) * 100;
  assert.ok(Math.abs(monthly! - expected) < 1e-9);
  // EA wages QoQ 0.9%: one quarter = 3 months -> (1.009)^4 - 1, not 3 quarters ^(4/3)
  const q = annualized3mFromMom([0.7, 0.8, 0.9], { periodsPerYear: 4 });
  assert.ok(Math.abs(q! - (Math.pow(1.009, 4) - 1) * 100) < 1e-9);
  assert.equal(printsPer3m(12), 3);
  assert.equal(printsPer3m(4), 1);
});

test("3-month average needs three prints", () => {
  assert.equal(movingAverage3([1, 2]), null);
  assert.equal(movingAverage3([1, 2, 3]), 2);
});
