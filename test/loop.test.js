// The game loop must run games at the same speed on 60Hz, 120Hz and 144Hz screens.
import { test } from "node:test";
import assert from "node:assert/strict";

// Minimal browser stand-ins so the loop can run under Node with a fake clock.
let now = 0;
let pending = null;
globalThis.document = { hidden: false, addEventListener() {}, removeEventListener() {} };
globalThis.performance = { now: () => now };
globalThis.requestAnimationFrame = (fn) => {
  pending = fn;
  return 1;
};
globalThis.cancelAnimationFrame = () => {
  pending = null;
};

const { createLoop, TICK_HZ } = await import("../public/js/engine/loop.js");

function simulate(refreshHz, seconds) {
  now = 0;
  let updates = 0;
  let renders = 0;
  const loop = createLoop({ update: () => (updates += 1), render: () => (renders += 1) });
  loop.start();
  const frameMs = 1000 / refreshHz;
  const frames = Math.round(seconds * refreshHz);
  for (let i = 0; i < frames; i += 1) {
    now += frameMs;
    const fn = pending;
    pending = null;
    fn?.(now);
  }
  loop.destroy();
  return { updates, renders };
}

for (const hz of [60, 120, 144]) {
  test(`${hz}Hz screen runs ${TICK_HZ} updates per second`, () => {
    const { updates, renders } = simulate(hz, 10);
    assert.ok(Math.abs(updates - TICK_HZ * 10) <= 1, `got ${updates} updates in 10s`);
    assert.equal(renders, hz * 10);
  });
}
