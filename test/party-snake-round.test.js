// A SNAKE ROYALE round (lobby -> countdown -> playing -> results), driven with a fake clock.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSnakeRound, SNAKE_TIMING } from "../server/party/snake-round.js";
import { COLORS } from "../server/party/room.js";
import { MIN_PLAYERS } from "../server/party/round.js";
import { START_LENGTH, stepMsAt } from "../public/js/shared/snake-battle.js";

const STEP = 100;
const TIMING = { countdownMs: 3000, endPauseMs: 1500, stepMs: STEP };
const GO = TIMING.countdownMs; // rounds in these tests start at 0
const at = (step) => GO + step * STEP; // when step N is due
// New food always lands in the bottom-right corner, away from every snake.
const farFood = () => 0.999999;

const players = (n) =>
  Array.from({ length: n }, (_, i) => ({ clientId: `phone-${i}`, slot: i, color: COLORS[i], name: `P${i}` }));

function playing(n, random = farFood) {
  const round = createSnakeRound(TIMING, { random });
  round.start(players(n), 0);
  round.tick(GO);
  return round;
}

// Runs steps `from`..`to`, applying turns before the step they're listed under.
// Returns every step's result.
function run(round, from, to, turns = {}) {
  const out = [];
  for (let step = from; step <= to; step += 1) {
    for (const [clientId, dir] of turns[step] ?? []) round.turn(clientId, { round: round.snapshot(0).number, dir }, at(step) - 1);
    out.push(round.advance(at(step)));
  }
  return out;
}

test("a round starts with fewer than 4 players, down to the minimum", () => {
  assert.equal(MIN_PLAYERS, 1);
  const round = createSnakeRound(TIMING);
  assert.deepEqual(round.start([], 0), { error: "NEED AT LEAST 1 PLAYER TO START." });
  assert.equal(round.phase, "lobby");
  assert.equal(round.frame(), null);
  assert.deepEqual(round.start(players(2), 0), { ok: true });
  assert.equal(round.phase, "countdown");
  assert.equal(round.start(players(2), 10).error, "A ROUND IS ALREADY RUNNING.");
  const snap = round.snapshot(1000);
  assert.equal(snap.startsInMs, 2000);
  assert.deepEqual(
    snap.players.map((p) => [p.slot, p.color, p.name, p.alive, p.length]),
    [
      [0, "red", "P0", true, START_LENGTH],
      [1, "blue", "P1", true, START_LENGTH],
    ]
  );
  // The board is there during the countdown, so players can find their snake.
  assert.equal(round.frame().snakes.length, 2);
  assert.equal(SNAKE_TIMING.countdownMs, 3000);
});

test("the board only moves after GO, and turns before GO or for another round don't count", () => {
  const round = createSnakeRound(TIMING, { random: farFood });
  round.start(players(1), 0);
  assert.equal(round.turn("phone-0", { round: 1, dir: "up" }, 1000), false, "countdown");
  assert.equal(round.advance(GO + STEP), null, "not playing yet without a tick");
  assert.equal(round.tick(GO), true);
  assert.equal(round.phase, "playing");
  assert.equal(round.advance(GO + STEP - 1), null);
  assert.equal(round.turn("phone-0", { round: 2, dir: "up" }, GO), false, "another round");
  assert.equal(round.turn("phone-0", { round: 1, dir: "diagonal" }, GO), false);
  assert.equal(round.turn("nobody", { round: 1, dir: "up" }, GO), false);
  assert.equal(round.turn("phone-0", { round: 1, dir: "up" }, GO), true);
  const result = round.advance(GO + STEP);
  assert.equal(result.frame.step, 1);
  assert.deepEqual(result.frame.snakes[0].body.slice(0, 2), [6, 2], "it went up");
});

test("steps follow the clock, one per call, and a stall slows the game instead of jumping", () => {
  const round = playing(1);
  assert.equal(round.advance(at(1)).frame.step, 1);
  assert.equal(round.advance(at(1) + 50), null);
  assert.equal(round.advance(at(2)).frame.step, 2);
  // The server was busy for a second: one step now, then the normal gap again.
  assert.equal(round.advance(at(2) + 1000).frame.step, 3);
  assert.equal(round.advance(at(2) + 1001), null);
  assert.equal(round.advance(at(2) + 1000 + STEP).frame.step, 4);
});

test("without a fixed step, the speed comes from the rules", () => {
  const round = createSnakeRound({ countdownMs: 0 }, { random: farFood });
  round.start(players(1), 0);
  round.tick(0);
  const first = stepMsAt(0);
  assert.equal(round.advance(Math.floor(first) - 1), null);
  assert.equal(round.advance(Math.ceil(first)).frame.step, 1);
});

test("playing alone, the round ends when your snake dies, then the results follow a pause", () => {
  const round = playing(1);
  const steps = run(round, 1, 4, { 1: [["phone-0", "up"]] });
  assert.deepEqual(
    steps.map((s) => s.over),
    [false, false, false, true]
  );
  assert.deepEqual(steps[3].deaths, [{ clientId: "phone-0", slot: 0, cause: { type: "wall" } }]);
  assert.equal(round.advance(at(5)), null, "nothing moves once it's over");
  assert.equal(round.phase, "playing");
  assert.equal(round.snapshot(at(4)).over, true);
  assert.equal(round.tick(at(4) + TIMING.endPauseMs - 1), false);
  assert.equal(round.tick(at(4) + TIMING.endPauseMs), true);
  assert.equal(round.phase, "results");
  const snap = round.snapshot(0);
  assert.equal(snap.winner, null, "nobody wins alone");
  assert.equal(snap.draw, false);
  assert.equal(round.viewFor("phone-0", 0).youWon, false);
  assert.deepEqual(
    snap.results.map((r) => [r.rank, r.name, r.alive, r.length, r.outAtMs]),
    [[1, "P0", false, START_LENGTH, 4 * STEP]]
  );
});

test("with 2 or more, the last snake left wins straight away", () => {
  const round = playing(3);
  run(round, 1, 3, { 1: [["phone-0", "up"]] });
  const step4 = round.advance(at(4));
  assert.deepEqual(
    step4.deaths.map((d) => d.clientId),
    ["phone-0"]
  );
  assert.equal(step4.over, false, "two snakes are still going");
  // Blue turns right off the top-right: (28,y) -> x 32 on its 4th step.
  run(round, 5, 8, { 5: [["phone-1", "right"]] });
  assert.equal(round.snapshot(at(8)).over, true);
  assert.equal(round.snapshot(at(8)).winner, "P2");
  assert.equal(round.turn("phone-2", { round: 1, dir: "up" }, at(8)), false, "no turns once it's over");
  round.tick(at(8) + TIMING.endPauseMs);
  assert.deepEqual(
    round.snapshot(0).results.map((r) => [r.rank, r.name, r.alive]),
    [
      [1, "P2", true],
      [2, "P1", false],
      [3, "P0", false],
    ]
  );
});

test("when the last snakes die together, the longer one wins, and equal lengths draw", () => {
  // Equal: red and blue both hit a wall on step 4.
  const draw = playing(2);
  run(draw, 1, 4, { 1: [["phone-0", "up"], ["phone-1", "right"]] });
  let snap = draw.snapshot(at(4));
  assert.equal(snap.over, true);
  assert.equal(snap.winner, null);
  assert.equal(snap.draw, true);
  assert.deepEqual(
    snap.results.map((r) => r.rank),
    [1, 1]
  );

  // Longer: food fills the top row from the left, so red eats its way along row 0
  // (4 pieces) and hits the left wall on step 10, just as blue hits the right wall.
  const longer = playing(2, () => 0);
  run(longer, 1, 10, {
    1: [["phone-0", "up"]],
    4: [["phone-0", "left"]],
    7: [["phone-1", "right"]],
  });
  snap = longer.snapshot(at(10));
  assert.equal(snap.over, true);
  assert.equal(snap.draw, false);
  assert.equal(snap.winner, "P0");
  assert.deepEqual(
    snap.results.map((r) => [r.rank, r.name, r.length]),
    [
      [1, "P0", 8],
      [2, "P1", START_LENGTH],
    ]
  );
});

test("someone removed mid-round is out, their snake turns into food, and that can end the round", () => {
  const round = playing(2);
  run(round, 1, 2);
  assert.equal(round.remove("phone-0", at(2) + 10), true);
  assert.equal(round.remove("phone-0", at(2) + 10), false);
  const frame = round.frame();
  assert.equal(frame.snakes.find((s) => s.slot === 0).alive, false);
  assert.equal(frame.food.filter((_, i) => i % 3 === 2 && frame.food[i] === 0).length, START_LENGTH);
  const snap = round.snapshot(at(3));
  assert.equal(snap.over, true);
  assert.equal(snap.winner, "P1");
  assert.deepEqual(
    snap.results.map((r) => r.name),
    ["P1"],
    "a player who left isn't in the results"
  );
});

test("someone removed before GO never played: the rest carry on, even alone", () => {
  const round = createSnakeRound(TIMING, { random: farFood });
  round.start(players(2), 0);
  round.remove("phone-0", 1000);
  const frame = round.frame();
  assert.equal(frame.food.filter((_, i) => i % 3 === 2 && frame.food[i] === 0).length, 0, "no food left at red's spawn");
  round.tick(GO);
  run(round, 1, 5);
  assert.equal(round.snapshot(at(5)).over, false, "blue plays on alone");
  // Blue heads down column 28 from row 6, so it hits the bottom wall on step 14.
  run(round, 6, 14);
  assert.equal(round.snapshot(at(14)).over, true);
});

test("END ROUND from the big screen ranks the live snakes by length", () => {
  const round = playing(2);
  run(round, 1, 2);
  assert.equal(round.end(at(2) + 5), true);
  assert.equal(round.end(at(2) + 6), false);
  assert.equal(round.advance(at(3)), null);
  const snap = round.snapshot(0);
  assert.equal(snap.draw, true, "same length");
  assert.ok(snap.results.every((r) => r.alive && r.rank === 1));
  const lobby = createSnakeRound(TIMING);
  assert.equal(lobby.end(0), false, "nothing to end");
});

test("each phone gets its own view: its corner, its snake, and later its result", () => {
  const round = createSnakeRound(TIMING, { random: farFood });
  round.start(players(2), 0);
  const red = round.viewFor("phone-0", 1000);
  assert.equal(red.phase, "countdown");
  assert.equal(red.inRound, true);
  assert.equal(red.spawn, "TOP LEFT");
  assert.equal(red.startsInMs, 2000);
  assert.equal(round.viewFor("phone-1", 1000).spawn, "TOP RIGHT");
  const late = round.viewFor("late-phone", 1000);
  assert.equal(late.inRound, false);
  assert.equal(late.spawn, null);

  round.tick(GO);
  run(round, 1, 4, { 1: [["phone-0", "up"]] });
  const out = round.viewFor("phone-0", at(4));
  assert.equal(out.alive, false);
  assert.deepEqual(out.cause, { type: "wall" });
  assert.equal(out.result, null, "no result until the results are up");
  round.tick(at(4) + TIMING.endPauseMs);
  assert.deepEqual(round.viewFor("phone-0", 0).result, {
    rank: 2,
    of: 2,
    length: START_LENGTH,
    alive: false,
    outAtMs: 4 * STEP,
  });
  assert.equal(round.viewFor("phone-1", 0).result.rank, 1);
  assert.equal(round.viewFor("phone-1", 0).youWon, true);
  assert.equal(round.viewFor("phone-0", 0).youWon, false);
});

test("a crash into another snake names that snake", () => {
  // Red goes down to row 6 and then right; blue turns left along row 6. They swap cells
  // between steps 12 and 13, which is a head-on crash for both.
  const round = playing(2);
  const steps = run(round, 1, 13, {
    1: [["phone-0", "down"], ["phone-1", "left"]],
    4: [["phone-0", "right"]],
  });
  assert.deepEqual(steps.slice(0, 12).flatMap((s) => s.deaths), []);
  assert.deepEqual(
    steps[12].deaths.map((d) => [d.clientId, d.cause]),
    [
      ["phone-0", { type: "head", color: "blue", name: "P1" }],
      ["phone-1", { type: "head", color: "red", name: "P0" }],
    ]
  );
  assert.deepEqual(round.viewFor("phone-0", at(13)).cause, { type: "head", color: "blue", name: "P1" });
});

test("back to the lobby only from the results; reset works any time", () => {
  const round = playing(1);
  assert.equal(round.toLobby(), false);
  run(round, 1, 4, { 1: [["phone-0", "up"]] });
  round.tick(at(4) + TIMING.endPauseMs);
  assert.equal(round.toLobby(), true);
  assert.equal(round.phase, "lobby");
  assert.equal(round.frame(), null);
  assert.deepEqual(round.snapshot(0).players, []);
  assert.deepEqual(round.start(players(1), 0), { ok: true });
  assert.equal(round.snapshot(0).number, 2);
  round.reset();
  assert.equal(round.phase, "lobby");
  assert.equal(round.frame(), null);
});
