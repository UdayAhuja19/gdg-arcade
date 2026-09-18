// SNAKE ROYALE's board rules: moving, turning, crashing, eating and food.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COLS,
  ROWS,
  START_LENGTH,
  MAX_QUEUED_TURNS,
  MAX_STEPS_PER_SEC,
  START_STEPS_PER_SEC,
  SPEED_UP_EVERY_MS,
  createArena,
  foodTarget,
  spawn,
  stepsPerSec,
} from "../public/js/shared/snake-battle.js";

// The same "random" numbers every run.
function seeded(seed = 1) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

// New food always lands on the last free cell (the bottom-right corner), out of the way.
const farFood = () => 0.999999;

const cells = (...pairs) => pairs.map(([x, y]) => ({ x, y }));
const head = (arena, slot) => arena.snake(slot).body[0];
const foodCells = (arena) => {
  const flat = arena.food();
  const out = [];
  for (let i = 0; i < flat.length; i += 3) out.push({ x: flat[i], y: flat[i + 1], from: flat[i + 2] });
  return out;
};
const causes = (deaths) => Object.fromEntries(deaths.map((d) => [d.slot, d.cause]));

test("the five spawns are on the board and apart, and the corners are turned 180° from each other", () => {
  const seen = new Set();
  for (let slot = 0; slot < 5; slot += 1) {
    const { body } = spawn(slot);
    assert.equal(body.length, START_LENGTH);
    for (const c of body) {
      assert.ok(c.x >= 0 && c.x < COLS && c.y >= 0 && c.y < ROWS);
      const k = `${c.x},${c.y}`;
      assert.ok(!seen.has(k), `spawns overlap at ${k}`);
      seen.add(k);
    }
  }
  const turned = (c) => ({ x: COLS - 1 - c.x, y: ROWS - 1 - c.y });
  assert.deepEqual(spawn(0).body.map(turned), spawn(2).body);
  assert.deepEqual(spawn(1).body.map(turned), spawn(3).body);
  assert.deepEqual(
    [0, 1, 2, 3, 4].map((s) => spawn(s).dir),
    ["right", "down", "left", "up", "down"]
  );
  // Each snake's head is in front of its body.
  assert.deepEqual(spawn(0).body[0], { x: 6, y: 3 });
  assert.deepEqual(spawn(1).body[0], { x: 28, y: 6 });
  assert.deepEqual(spawn(4).body[0], { x: 16, y: 6 });
});

test("with five snakes, nobody who goes straight crashes in the first second", () => {
  // At the slowest speed (7 steps a second), so players have time to steer after GO.
  const arena = createArena([0, 1, 2, 3, 4], { random: farFood });
  for (let i = 0; i < START_STEPS_PER_SEC; i += 1) assert.deepEqual(arena.step().deaths, []);
  assert.equal(arena.alive, 5);
});

test("snakes move straight, one cell a step, keeping their length", () => {
  const arena = createArena([0, 1], { random: farFood });
  arena.step();
  assert.deepEqual(head(arena, 0), { x: 7, y: 3 });
  assert.deepEqual(head(arena, 1), { x: 28, y: 7 });
  assert.equal(arena.snake(0).length, START_LENGTH);
  assert.equal(arena.alive, 2);
});

test("turns queue up, one a step; reversing or repeating a direction is ignored", () => {
  const arena = createArena([0], { random: farFood });
  assert.equal(arena.turn(0, "left"), false, "reverse");
  assert.equal(arena.turn(0, "right"), false, "same direction");
  assert.equal(arena.turn(0, "sideways"), false);
  assert.equal(arena.turn(0, "toString"), false);
  assert.equal(arena.turn(0, "up"), true);
  assert.equal(arena.turn(0, "down"), false, "reverses the queued turn");
  assert.equal(arena.turn(0, "left"), true);
  assert.equal(MAX_QUEUED_TURNS, 2);
  assert.equal(arena.turn(0, "down"), false, "queue full");
  arena.step();
  assert.deepEqual(head(arena, 0), { x: 6, y: 2 });
  arena.step();
  assert.deepEqual(head(arena, 0), { x: 5, y: 2 });
  assert.equal(arena.snake(0).dir, "left");
});

test("a head off the board is a crash into the wall, and the snake is out", () => {
  const arena = createArena([0], { random: farFood });
  arena.turn(0, "up"); // red starts on row 3
  for (let i = 0; i < 3; i += 1) assert.deepEqual(arena.step().deaths, []);
  assert.deepEqual(arena.step().deaths, [{ slot: 0, cause: { type: "wall" } }]);
  assert.equal(arena.snake(0).alive, false);
  assert.equal(arena.alive, 0);
  assert.equal(arena.turn(0, "left"), false, "dead snakes don't turn");
  assert.deepEqual(arena.step(), { deaths: [], grew: [] }, "and don't move");
});

test("running into your own body is a crash", () => {
  const body = cells([5, 5], [4, 5], [3, 5], [3, 6], [4, 6], [5, 6], [6, 6]);
  const arena = createArena([0], { random: farFood, layout: { snakes: { 0: { dir: "right", body } } } });
  arena.turn(0, "down"); // (5,6) is part of the body and stays there
  assert.deepEqual(arena.step().deaths, [{ slot: 0, cause: { type: "self" } }]);
});

test("chasing your own tail is fine, because the tail moves out of the way", () => {
  const body = cells([6, 3], [5, 3], [5, 4], [6, 4]);
  const arena = createArena([0], { random: farFood, layout: { snakes: { 0: { dir: "right", body } } } });
  const turns = ["down", "left", "up", "right"];
  for (let i = 0; i < 12; i += 1) {
    assert.equal(arena.turn(0, turns[i % 4]), true);
    assert.deepEqual(arena.step().deaths, [], `step ${i + 1}`);
  }
});

test("another snake's tail is safe unless that snake is growing", () => {
  const layout = (food) => ({
    snakes: {
      0: { dir: "right", body: cells([2, 2], [1, 2], [0, 2]) },
      1: { dir: "down", body: cells([3, 4], [3, 3], [3, 2]) },
    },
    food,
  });
  const leaving = createArena([0, 1], { random: farFood, layout: layout([]) });
  assert.deepEqual(leaving.step().deaths, []);

  const staying = createArena([0, 1], { random: farFood, layout: layout(cells([3, 5])) });
  const { deaths, grew } = staying.step();
  assert.deepEqual(deaths, [{ slot: 0, cause: { type: "body", slot: 1 } }]);
  assert.deepEqual(grew, [1]);
  assert.equal(staying.snake(1).length, 4);
});

test("running into another snake's body kills only you", () => {
  const arena = createArena([0, 1], {
    random: farFood,
    layout: {
      snakes: {
        0: { dir: "right", body: cells([2, 5], [1, 5], [0, 5]) },
        1: { dir: "down", body: cells([3, 7], [3, 6], [3, 5], [3, 4]) },
      },
    },
  });
  assert.deepEqual(arena.step().deaths, [{ slot: 0, cause: { type: "body", slot: 1 } }]);
  assert.equal(arena.snake(1).alive, true);
  assert.deepEqual(head(arena, 1), { x: 3, y: 8 });
});

test("heads meeting in the same cell kill both", () => {
  const arena = createArena([0, 1], {
    random: farFood,
    layout: {
      snakes: {
        0: { dir: "right", body: cells([2, 5], [1, 5], [0, 5]) },
        1: { dir: "left", body: cells([4, 5], [5, 5], [6, 5]) },
      },
    },
  });
  assert.deepEqual(causes(arena.step().deaths), { 0: { type: "head", slot: 1 }, 1: { type: "head", slot: 0 } });
  assert.equal(arena.alive, 0);
});

test("heads swapping cells kill both, instead of passing through each other", () => {
  const arena = createArena([0, 1], {
    random: farFood,
    layout: {
      snakes: {
        0: { dir: "right", body: cells([2, 5], [1, 5], [0, 5]) },
        1: { dir: "left", body: cells([3, 5], [4, 5], [5, 5]) },
      },
    },
  });
  assert.deepEqual(causes(arena.step().deaths), { 0: { type: "head", slot: 1 }, 1: { type: "head", slot: 0 } });
  // Both bodies, from before the crash, are food now.
  assert.equal(foodCells(arena).filter((f) => f.from === 0 || f.from === 1).length, 6);
});

test("heads meeting on food kill both, and nobody grows", () => {
  const arena = createArena([0, 1], {
    random: farFood,
    layout: {
      snakes: {
        0: { dir: "right", body: cells([2, 5], [1, 5], [0, 5]) },
        1: { dir: "left", body: cells([4, 5], [5, 5], [6, 5]) },
      },
      food: cells([3, 5]),
    },
  });
  const { deaths, grew } = arena.step();
  assert.equal(deaths.length, 2);
  assert.deepEqual(grew, []);
  assert.ok(foodCells(arena).some((f) => f.x === 3 && f.y === 5 && f.from === -1), "the food is still there");
});

test("eating grows a snake by exactly one, and new food keeps the board topped up", () => {
  const arena = createArena([0], {
    random: farFood,
    layout: { snakes: { 0: { dir: "right", body: cells([2, 2], [1, 2], [0, 2]) } }, food: cells([3, 2], [4, 2]) },
  });
  assert.equal(foodCells(arena).length, foodTarget(1));
  const lengths = [];
  for (let i = 0; i < 3; i += 1) {
    const { grew } = arena.step();
    lengths.push([arena.snake(0).length, grew]);
  }
  assert.deepEqual(lengths, [
    [4, [0]],
    [5, [0]],
    [5, []],
  ]);
  const food = foodCells(arena);
  assert.equal(food.length, foodTarget(1));
  for (const f of food) {
    assert.ok(!arena.snake(0).body.some((c) => c.x === f.x && c.y === f.y), "no food under a snake");
  }
});

test("a dead snake's body turns into food, except where a live snake now is", () => {
  const arena = createArena([0, 1], {
    random: farFood,
    layout: {
      snakes: {
        // Red crashes into the left wall; blue moves into the cell red's tail was on.
        0: { dir: "left", body: cells([0, 5], [1, 5], [2, 5]) },
        1: { dir: "up", body: cells([2, 6], [2, 7], [2, 8]) },
      },
    },
  });
  assert.deepEqual(arena.step().deaths, [{ slot: 0, cause: { type: "wall" } }]);
  const corpse = foodCells(arena).filter((f) => f.from === 0);
  assert.deepEqual(
    corpse.map((f) => [f.x, f.y]).sort(),
    [
      [0, 5],
      [1, 5],
    ]
  );
  assert.deepEqual(head(arena, 1), { x: 2, y: 5 });
});

test("a removed player's snake turns into food, or just vanishes before GO", () => {
  const arena = createArena([0, 1], { random: farFood });
  assert.equal(arena.kill(0, { type: "left" }), true);
  assert.equal(arena.kill(0, { type: "left" }), false);
  assert.equal(foodCells(arena).filter((f) => f.from === 0).length, START_LENGTH);
  assert.equal(arena.kill(1, { type: "left" }, { leaveFood: false }), true);
  assert.equal(foodCells(arena).filter((f) => f.from === 1).length, 0);
  assert.equal(arena.alive, 0);
});

test("food never spawns on a snake or on other food, even on a crowded board", () => {
  const arena = createArena([0, 1, 2, 3], { cols: 8, rows: 8, random: seeded(3), layout: {
    snakes: {
      0: { dir: "right", body: cells([3, 0], [2, 0], [1, 0], [0, 0]) },
      1: { dir: "down", body: cells([7, 3], [7, 2], [7, 1], [7, 0]) },
      2: { dir: "left", body: cells([4, 7], [5, 7], [6, 7], [7, 7]) },
      3: { dir: "up", body: cells([0, 4], [0, 5], [0, 6], [0, 7]) },
    },
  } });
  const food = foodCells(arena);
  assert.equal(food.length, foodTarget(4));
  const keys = new Set(food.map((f) => `${f.x},${f.y}`));
  assert.equal(keys.size, food.length);
  for (let slot = 0; slot < 4; slot += 1) {
    for (const c of arena.snake(slot).body) assert.ok(!keys.has(`${c.x},${c.y}`));
  }
});

test("the same random numbers give the same game", () => {
  const play = () => {
    const arena = createArena([0, 1, 2, 3], { random: seeded(7) });
    const turns = ["up", "left", "down", "right"];
    for (let i = 0; i < 80; i += 1) {
      arena.turn(i % 4, turns[(i * 3) % 4]);
      arena.step();
    }
    return JSON.stringify([arena.snakes(), arena.food()]);
  };
  assert.equal(play(), play());
});

test("speed creeps up and stops at the maximum", () => {
  assert.equal(stepsPerSec(0), START_STEPS_PER_SEC);
  assert.ok(stepsPerSec(SPEED_UP_EVERY_MS) > START_STEPS_PER_SEC);
  assert.equal(stepsPerSec(60 * 60_000), MAX_STEPS_PER_SEC);
});
