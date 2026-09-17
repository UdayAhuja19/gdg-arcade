// MASH BATTLE's bar: taps fill it, it drains, and fast drain only kicks in after a pause.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BAR_FULL,
  TAP_FILL,
  DRAIN_PER_SEC,
  IDLE_AFTER_MS,
  IDLE_DRAIN_PER_SEC,
  MIN_FILL_MS,
  createBar,
} from "../public/js/shared/tap-battle.js";

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ≈ ${expected}`);

test("each tap fills the bar, and taps before the start don't count", () => {
  const bar = createBar(1000);
  assert.equal(bar.tap(500), 0);
  assert.equal(bar.taps, 0);
  assert.equal(bar.tap(1000), TAP_FILL);
  assert.equal(bar.taps, 1);
});

test("the bar drains slowly while tapping and fast after a pause", () => {
  const bar = createBar(0);
  for (let i = 0; i < 25; i += 1) bar.tap(i * 100); // 25 taps over 2.4s
  close(bar.level(2400), 25 * TAP_FILL - 2.4 * DRAIN_PER_SEC);

  // A second after the last tap: slow drain for the whole second, fast drain after the pause.
  const before = bar.level(2400);
  close(bar.level(3400), before - 1 * DRAIN_PER_SEC - (1 - IDLE_AFTER_MS / 1000) * IDLE_DRAIN_PER_SEC);
  assert.equal(bar.level(60_000), 0, "never below empty");
});

test("steady tapping fills the bar, then it stays full", () => {
  const bar = createBar(0);
  let t = 0;
  while (bar.filledMs === null && t < 60_000) {
    bar.tap(t);
    t += 100; // 10 taps a second
  }
  assert.equal(bar.level(t), BAR_FULL);
  // 10 taps/s fills 20/s and drains 6/s: about 7 seconds.
  assert.ok(bar.filledMs > 6500 && bar.filledMs < 7500, `filled in ${bar.filledMs}ms`);
  assert.equal(bar.level(t + 10_000), BAR_FULL, "a full bar doesn't drain");
  bar.tap(t + 10_100);
  assert.equal(bar.taps, Math.round(bar.filledMs / 100) + 1, "taps after full don't count");
});

test("nobody can fill the bar faster than the minimum time", () => {
  // 30 taps/s (several fingers) fill 60/s and drain 6/s: 100 takes just under 2 seconds.
  assert.equal(MIN_FILL_MS, 1851);
  const bar = createBar(0);
  for (let t = 0; bar.filledMs === null; t += 1000 / 30) bar.tap(t);
  assert.ok(bar.filledMs >= MIN_FILL_MS - 100, `filled in ${bar.filledMs}ms`);
});

test("a saved bar picks up exactly where it was, even on a different clock", () => {
  const bar = createBar(1000);
  for (let t = 1000; t < 3000; t += 100) bar.tap(t);
  const saved = JSON.parse(JSON.stringify(bar.save()));

  // The same bar on a page whose clock starts somewhere else entirely.
  const again = createBar(50_000, saved);
  assert.equal(again.taps, bar.taps);
  close(again.level(50_000 + 2500), bar.level(3500));
  again.tap(50_000 + 2600);
  assert.equal(again.taps, bar.taps + 1);

  // A full bar stays full, with the same finish time.
  const full = createBar(0);
  for (let t = 0; full.filledMs === null; t += 100) full.tap(t);
  const restored = createBar(9_000, full.save());
  assert.equal(restored.filledMs, full.filledMs);
  assert.equal(restored.level(99_999), BAR_FULL);
});

test("a bar can be picked up from just a level", () => {
  const bar = createBar(0, { level: 40, lastAt: 5000 });
  close(bar.level(5000), 40);
  assert.ok(bar.level(6000) < 40);
});
