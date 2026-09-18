// SPLIT SECOND's rules: targets, errors, totals and how times are written.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LEGS,
  MISS_MS,
  TARGET_CHOICES_MS,
  bestOf,
  errorOf,
  fmt,
  isBullseye,
  signed,
  targetsFor,
  totalOf,
} from "../public/js/shared/split-second.js";

test("a game gets 3 different whole-second targets between 1 and 5", () => {
  for (const r of [0, 0.3, 0.5, 0.999999]) {
    const targets = targetsFor(() => r);
    assert.equal(targets.length, LEGS);
    assert.equal(new Set(targets).size, LEGS, "no repeats");
    for (const t of targets) assert.ok(TARGET_CHOICES_MS.includes(t));
  }
  assert.deepEqual(targetsFor(() => 0), [1000, 2000, 3000]);
  assert.deepEqual(targetsFor(() => 0.999999), [5000, 4000, 3000]);
});

test("error is the distance either side of the target", () => {
  assert.equal(errorOf(3120, 3000), 120);
  assert.equal(errorOf(2880, 3000), 120);
  assert.equal(errorOf(3000, 3000), 0);
});

test("a round with nothing locked costs MISS_MS in the total and the best", () => {
  const legs = [{ ms: 1040, error: 40 }, null, { ms: 3200, error: 200 }];
  assert.equal(totalOf(legs), 40 + MISS_MS + 200);
  assert.equal(bestOf(legs), 40);
  assert.equal(bestOf([null, null, null]), MISS_MS);
});

test("times read like the trend: seconds and hundredths, signed off the target", () => {
  assert.equal(fmt(3120), "3.12");
  assert.equal(signed(3120, 3000), "+0.12");
  assert.equal(signed(2940, 3000), "−0.06");
  assert.equal(signed(3000, 3000), "DEAD ON");
  assert.ok(isBullseye(50));
  assert.ok(!isBullseye(51));
});
