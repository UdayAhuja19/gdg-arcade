// MASH BATTLE's bar: taps fill it, it leaks (faster the fuller it is), and fast drain kicks in after a pause.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BAR_FULL,
  TAP_FILL,
  IDLE_AFTER_MS,
  MIN_FILL_MS,
  MAX_TAPS_PER_SEC,
  ROUND_MS,
  createBar,
  settleLevel,
} from "../public/js/shared/tap-battle.js";

const close = (actual, expected, within = 1e-9) => assert.ok(Math.abs(actual - expected) < within, `${actual} ≈ ${expected}`);

// Taps at a steady speed for up to `ms` (never longer than a round), then returns the bar.
function tapSteadily(tapsPerSec, ms = ROUND_MS) {
  const bar = createBar(0);
  const gap = 1000 / tapsPerSec;
  for (let t = 0; t < ms && bar.filledMs === null; t += gap) bar.tap(t);
  return bar;
}

test("each tap fills the bar, and taps before the start don't count", () => {
  const bar = createBar(1000);
  assert.equal(bar.tap(500), 0);
  assert.equal(bar.taps, 0);
  assert.equal(bar.tap(1000), TAP_FILL);
  assert.equal(bar.taps, 1);
});

test("the bar leaks while tapping, faster when fuller, and drains fast after a pause", () => {
  const low = createBar(0, { level: 20, lastAt: 0, lastTapAt: 0 });
  const high = createBar(0, { level: 80, lastAt: 0, lastTapAt: 0 });
  const lostLow = 20 - low.level(300);
  const lostHigh = 80 - high.level(300);
  assert.ok(lostLow > 0 && lostHigh > lostLow, `lost ${lostLow} from 20%, ${lostHigh} from 80%`);

  // A second without tapping loses much more once the idle pause has passed.
  const idle = createBar(0, { level: 80, lastAt: 0, lastTapAt: 0 });
  const before = idle.level(IDLE_AFTER_MS);
  const lostAfterPause = before - idle.level(IDLE_AFTER_MS + 300);
  assert.ok(lostAfterPause > lostHigh * 1.5, `lost ${lostAfterPause} in 300ms after the pause`);
  assert.equal(idle.level(60_000), 0, "never below empty");
});

test("one finger or two thumbs can't fill it; only fast drumming can, and it takes a while", () => {
  // One finger (about 8 taps a second) and two thumbs (about 14) stall below full.
  for (const speed of [8, 14, 16]) {
    const bar = tapSteadily(speed);
    assert.equal(bar.filledMs, null, `${speed} taps/s filled it`);
    close(bar.level(ROUND_MS), settleLevel(speed), 3);
  }
  // Drumming with several fingers fills it, but has to be kept up for many seconds.
  const fast = tapSteadily(20);
  assert.ok(fast.filledMs > 10_000 && fast.filledMs < 14_000, `20 taps/s filled in ${fast.filledMs}ms`);
  const faster = tapSteadily(24);
  assert.ok(faster.filledMs > 6_500 && faster.filledMs < 8_500, `24 taps/s filled in ${faster.filledMs}ms`);
});

test("slowing down part way through (tired fingers) means the bar never fills", () => {
  const bar = createBar(0);
  for (let t = 0; t < ROUND_MS && bar.filledMs === null; ) {
    bar.tap(t);
    t += 1000 / Math.max(8, 24 - 0.6 * (t / 1000)); // 24 taps/s, losing 0.6 every second
  }
  assert.equal(bar.filledMs, null);
  assert.ok(bar.level(ROUND_MS) < 70);
});

test("a full bar stays full, and taps after full don't count", () => {
  const bar = tapSteadily(24);
  const at = bar.filledMs;
  assert.equal(bar.level(at + 10_000), BAR_FULL, "a full bar doesn't drain");
  const taps = bar.taps;
  bar.tap(at + 10_100);
  assert.equal(bar.taps, taps);
});

test("nobody can fill the bar faster than the minimum time", () => {
  // 30 taps/s from the very start, leak included: about 5 seconds.
  assert.equal(MIN_FILL_MS, 5115);
  const bar = tapSteadily(MAX_TAPS_PER_SEC);
  assert.ok(bar.filledMs >= MIN_FILL_MS - 100, `filled in ${bar.filledMs}ms`);
});

test("a saved bar picks up exactly where it was, even on a different clock", () => {
  const bar = createBar(1000);
  for (let t = 1000; t < 3000; t += 50) bar.tap(t);
  const saved = JSON.parse(JSON.stringify(bar.save()));

  // The same bar on a page whose clock starts somewhere else entirely.
  const again = createBar(50_000, saved);
  assert.equal(again.taps, bar.taps);
  close(again.level(50_000 + 2500), bar.level(3500));
  again.tap(50_000 + 2600);
  assert.equal(again.taps, bar.taps + 1);

  // A full bar stays full, with the same finish time.
  const full = tapSteadily(24);
  const restored = createBar(9_000, full.save());
  assert.equal(restored.filledMs, full.filledMs);
  assert.equal(restored.level(99_999), BAR_FULL);
});

test("a bar can be picked up from just a level", () => {
  const bar = createBar(0, { level: 40, lastAt: 5000 });
  close(bar.level(5000), 40);
  assert.ok(bar.level(6000) < 40);
});
