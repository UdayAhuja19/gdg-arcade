// Dino Run and Stack Tower should get faster at clear checkpoints, then level off.
import { test } from "node:test";
import assert from "node:assert/strict";
import { speedAt as dinoSpeed, checkpointAt } from "../public/js/games/dino.js";
import { speedAt as stackSpeed } from "../public/js/games/stack.js";

test("Dino Run speeds up at every 100-point checkpoint until 1,200", () => {
  assert.equal(dinoSpeed(0), 6);
  assert.equal(dinoSpeed(99), 6, "no change before the first checkpoint");
  assert.equal(dinoSpeed(100), 6.5);
  assert.equal(dinoSpeed(450), 8);
  assert.equal(dinoSpeed(1200), 12);
  assert.equal(dinoSpeed(5000), 12, "top speed is capped");
  for (let cp = 1; cp <= 12; cp += 1) {
    const score = cp * 100;
    assert.ok(dinoSpeed(score) > dinoSpeed(score - 1), `faster at ${score}`);
    assert.equal(dinoSpeed(score + 99), dinoSpeed(score), `steady between checkpoints after ${score}`);
  }
  assert.equal(checkpointAt(1250), 12);
});

test("Stack Tower speeds up every 5 blocks until 50 blocks", () => {
  assert.equal(stackSpeed(0), 3);
  assert.equal(stackSpeed(4), 3, "no change before the first checkpoint");
  assert.ok(Math.abs(stackSpeed(5) - 3.4) < 1e-9);
  assert.ok(Math.abs(stackSpeed(20) - 4.6) < 1e-9);
  assert.equal(stackSpeed(50), 7);
  assert.equal(stackSpeed(80), 7, "top speed is capped");
  for (let level = 5; level <= 50; level += 5) {
    assert.ok(stackSpeed(level) > stackSpeed(level - 1), `faster at ${level} blocks`);
  }
});
