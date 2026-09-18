// LIGHTS OUT: the rules and a round (3 starts of grid -> go -> reveal), driven with a fake clock.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createLightsRound, LIGHTS_TIMING } from "../server/party/lights-round.js";
import {
  HOLD_MAX_MS,
  HOLD_MIN_MS,
  LIGHT_EVERY_MS,
  PENALTY_MS,
  fmt,
  holdFor,
  legText,
  outAfter,
  scoreOf,
  totalOf,
} from "../public/js/shared/lights-out.js";

test("the rules: five lights a second apart, a random hold, and the scores", () => {
  assert.equal(holdFor(() => 0), HOLD_MIN_MS);
  assert.equal(holdFor(() => 0.999999), HOLD_MAX_MS);
  assert.equal(holdFor(() => 0.5) % 10, 0);
  assert.equal(outAfter(700), 4 * LIGHT_EVERY_MS + 700);
  assert.equal(scoreOf({ ms: 234, jump: false }), 234);
  assert.equal(scoreOf({ ms: null, jump: true }), PENALTY_MS);
  assert.equal(scoreOf(null), PENALTY_MS);
  assert.equal(totalOf([{ ms: 200, jump: false }, { ms: null, jump: true }, null]), 200 + 2 * PENALTY_MS);
  assert.equal(fmt(234), "0.234");
  assert.equal(legText({ ms: null, jump: true }), "JUMP START");
});

const { countdownMs, leadMs, reactMs, revealMs } = LIGHTS_TIMING;
const HOLDS = [500, 1000, 1500];
const players = (n) => Array.from({ length: n }, (_, i) => ({ clientId: `phone-${i}`, slot: i, color: "red", name: `P${i}` }));
// Start 1: the lights come on at LIGHTS, and go out at OUT.
const LIGHTS = countdownMs + leadMs;
const OUT = LIGHTS + outAfter(HOLDS[0]);

function onGrid(n) {
  const round = createLightsRound({ holds: HOLDS });
  round.start(players(n), 0);
  round.tick(countdownMs);
  return round;
}

test("the schedule is sent ahead as server times, so every screen turns off together", () => {
  const round = onGrid(2);
  assert.equal(round.stage, "grid");
  const view = round.viewFor("phone-0", countdownMs);
  assert.equal(view.lightsAt, LIGHTS);
  assert.equal(view.outAt, OUT);
  assert.deepEqual(view.lightTimes, [0, 1, 2, 3, 4].map((i) => LIGHTS + i * 1000));
  assert.equal(round.tick(OUT - 1), false);
  assert.equal(round.tick(OUT), true);
  assert.equal(round.stage, "go");
});

test("a reaction is the phone's own number, checked against when the tap arrived", () => {
  const round = onGrid(2);
  round.tick(OUT);
  // Tapped 230ms after its lights went out; the tap took 60ms to arrive.
  assert.equal(round.press("phone-0", { ms: 230 }, OUT + 290).status, "saved");
  assert.deepEqual(round.entry("phone-0").legs[0], { ms: 230, jump: false });
  assert.equal(round.press("phone-0", { ms: 100 }, OUT + 300).status, "final", "one tap a start");
  // Claims 150ms but the tap reached the server 10ms after lights out: can't be true.
  const round2 = onGrid(1);
  round2.tick(OUT);
  round2.press("phone-0", { ms: 500 }, OUT + 10);
  assert.equal(round2.entry("phone-0").legs[0].ms, 10 + 250);
});

test("a tap before lights out, or too fast to be a reaction, is a jump start", () => {
  const round = onGrid(3);
  assert.equal(round.press("phone-0", { jump: true }, LIGHTS - 10).status, "rejected", "before the first light, ignored");
  assert.equal(round.press("phone-0", { jump: true }, LIGHTS + 2000).status, "saved");
  assert.equal(round.entry("phone-0").legs[0].jump, true);
  // The phone thinks lights are out, but the server says it's 2 seconds early.
  round.press("phone-1", { ms: 300 }, OUT - 2000);
  assert.equal(round.entry("phone-1").legs[0].jump, true);
  round.tick(OUT);
  round.press("phone-2", { ms: 40 }, OUT + 100);
  assert.equal(round.entry("phone-2").legs[0].jump, true, "40ms is a guess, not a reaction");
});

test("everyone tapped ends the start; no tap in the window is a miss; three starts then results", () => {
  const round = onGrid(2);
  let t = OUT;
  for (let leg = 0; leg < 3; leg += 1) {
    round.tick(t);
    assert.equal(round.stage, "go");
    round.press("phone-0", { ms: 200 + leg * 10 }, t + 260);
    if (leg !== 1) round.press("phone-1", { ms: 300 }, t + 360);
    round.tick(leg === 1 ? t + reactMs : t + 360);
    assert.equal(round.stage, "reveal");
    const revealEnds = (leg === 1 ? t + reactMs : t + 360) + revealMs;
    round.tick(revealEnds);
    if (leg < 2) t = revealEnds + leadMs + outAfter(HOLDS[leg + 1]);
  }
  assert.equal(round.phase, "results");
  const snap = round.snapshot(t);
  assert.deepEqual(snap.results.map((r) => [r.name, r.total]), [["P0", 630], ["P1", 600 + PENALTY_MS]]);
  assert.equal(snap.winner, "P0");
  assert.equal(round.viewFor("phone-0", t).result.rank, 1);
});

test("strangers, other rounds and other starts don't count; lobby and reset work", () => {
  const round = onGrid(1);
  round.tick(OUT);
  assert.equal(round.press("stranger", { ms: 200 }, OUT + 250).status, "rejected");
  assert.equal(round.press("phone-0", { round: 9, ms: 200 }, OUT + 250).status, "too-late");
  assert.equal(round.press("phone-0", { leg: 2, ms: 200 }, OUT + 250).status, "too-late");
  assert.equal(round.toLobby(), false);
  round.reset();
  assert.equal(round.phase, "lobby");
});
