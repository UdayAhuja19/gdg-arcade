// A SPLIT SECOND round (3 legs of set -> run -> reveal), driven with a fake clock.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSplitRound, SPLIT_TIMING } from "../server/party/split-round.js";
import { MISS_MS, RUN_LIMIT_MS } from "../public/js/shared/split-second.js";

const { countdownMs, setMs, lockMs, revealMs } = SPLIT_TIMING;
const GO = countdownMs; // rounds start at 0
const RUN = GO + setMs; // leg 1's window opens
const players = (n) => Array.from({ length: n }, (_, i) => ({ clientId: `phone-${i}`, slot: i, color: "red", name: `P${i}` }));

// Targets 1000, 2000, 3000 (random() = 0).
function running(n) {
  const round = createSplitRound({}, { random: () => 0 });
  round.start(players(n), 0);
  round.tick(GO);
  round.tick(RUN);
  return round;
}

// start at `at`, stop after `ms` of the phone's own clock, reported `hop` later.
function runOnce(round, id, at, ms, hop = 30) {
  round.act(id, { event: "start" }, at + hop);
  return round.act(id, { event: "stop", ms }, at + ms + hop);
}

test("the countdown, then the target is shown, then the window opens", () => {
  const round = createSplitRound({}, { random: () => 0 });
  assert.deepEqual(round.start([], 0), { error: "NEED AT LEAST 1 PLAYER TO START." });
  assert.deepEqual(round.start(players(2), 0), { ok: true });
  assert.equal(round.phase, "countdown");
  assert.equal(round.tick(GO), true);
  assert.equal(round.stage, "set");
  assert.equal(round.snapshot(GO).targetMs, 1000);
  assert.equal(round.act("phone-0", { event: "start" }, GO + 100).status, "rejected", "nothing before the window");
  assert.equal(round.tick(RUN), true);
  assert.equal(round.stage, "run");
});

test("runs can be redone as often as you like; the phone's own number counts", () => {
  const round = running(2);
  assert.equal(runOnce(round, "phone-0", RUN, 1300).status, "saved");
  assert.equal(round.entry("phone-0").current.error, 300);
  assert.equal(runOnce(round, "phone-0", RUN + 3000, 1020).status, "saved");
  assert.equal(round.entry("phone-0").current.ms, 1020, "the latest run replaces the last");
  assert.equal(round.entry("phone-0").runs, 2);
});

test("a stop is kept inside what the run could have lasted on the server's clock", () => {
  const round = running(1);
  round.act("phone-0", { event: "start" }, RUN + 100);
  // Claims 9 seconds, but the server saw the run last 1.1s.
  round.act("phone-0", { event: "stop", ms: 9000 }, RUN + 1200);
  assert.equal(round.entry("phone-0").current.ms, 1100 + 1500);
  assert.equal(round.act("phone-0", { event: "stop", ms: 900 }, RUN + 1300).status, "rejected", "no run going");
  assert.equal(round.act("phone-0", { event: "stop", ms: "lots" }, RUN + 1400).status, "rejected");
});

test("locking in freezes the time; everyone locked ends the leg and reveals it", () => {
  const round = running(2);
  runOnce(round, "phone-0", RUN, 1040);
  assert.equal(round.act("phone-0", { event: "lock" }, RUN + 2000).status, "saved");
  assert.equal(round.act("phone-0", { event: "start" }, RUN + 2100).status, "final", "locked phones can't run again");
  assert.equal(round.viewFor("phone-0", RUN + 2100).reveal, null, "nothing shown until the reveal");
  assert.equal(round.act("phone-1", { event: "lock" }, RUN + 2200).status, "rejected", "nothing to lock yet");
  runOnce(round, "phone-1", RUN + 2300, 900);
  round.act("phone-1", { event: "lock" }, RUN + 3500);
  assert.equal(round.tick(RUN + 3510), true);
  assert.equal(round.stage, "reveal");
  assert.deepEqual(round.viewFor("phone-0", RUN + 3510).reveal, { ms: 1040, error: 40, total: 40 });
  assert.deepEqual(round.snapshot(RUN + 3510).results.map((r) => r.name), ["P0", "P1"]);
});

test("at the window's end, an unlocked last run stands and no run at all is a miss", () => {
  const round = running(3);
  runOnce(round, "phone-0", RUN, 1100);
  assert.equal(round.tick(RUN + lockMs - 1), false);
  assert.equal(round.tick(RUN + lockMs), true);
  assert.equal(round.entry("phone-0").legs[0].ms, 1100);
  assert.equal(round.entry("phone-1").legs[0], null);
  assert.equal(round.entry("phone-1").total, MISS_MS);
});

test("a run left going stops itself", () => {
  const round = running(1);
  round.act("phone-0", { event: "start" }, RUN);
  round.tick(RUN + RUN_LIMIT_MS);
  assert.equal(round.viewFor("phone-0", RUN + RUN_LIMIT_MS).running, false);
});

test("three legs, then results by lowest total error; a tie shares the rank", () => {
  const round = running(2);
  let t = RUN;
  for (const target of [1000, 2000, 3000]) {
    assert.equal(round.snapshot(t).targetMs, target);
    runOnce(round, "phone-0", t, target + 10);
    runOnce(round, "phone-1", t, target - 10);
    round.act("phone-0", { event: "lock" }, t + 6000);
    round.act("phone-1", { event: "lock" }, t + 6000);
    round.tick(t + 6000);
    round.tick(t + 6000 + revealMs);
    round.tick(t + 6000 + revealMs + setMs);
    t += 6000 + revealMs + setMs;
  }
  assert.equal(round.phase, "results");
  const snap = round.snapshot(t);
  assert.deepEqual(snap.results.map((r) => [r.rank, r.total]), [[1, 30], [1, 30]]);
  assert.equal(snap.draw, true);
  assert.equal(round.viewFor("phone-0", t).result.total, 30);
});

test("a phone's view never has another player's time or its own before the reveal", () => {
  const round = running(2);
  runOnce(round, "phone-1", RUN, 1234);
  const view = round.viewFor("phone-0", RUN + 1500);
  assert.equal(view.reveal, null);
  assert.equal(JSON.stringify(view).includes("1234"), false);
  assert.equal(JSON.stringify(round.viewFor("phone-1", RUN + 1500)).includes("1234"), false, "not even its own");
  assert.equal(round.viewFor("phone-1", RUN + 1500).canLock, true);
});

test("wrong round or leg is too late; strangers are rejected; remove, lobby and reset work", () => {
  const round = running(2);
  assert.equal(round.act("phone-0", { round: 9, event: "start" }, RUN).status, "too-late");
  assert.equal(round.act("phone-0", { leg: 2, event: "start" }, RUN).status, "too-late");
  assert.equal(round.act("stranger", { event: "start" }, RUN).status, "rejected");
  assert.equal(round.remove("phone-1"), true);
  assert.equal(round.toLobby(), false, "only from the results");
  round.reset();
  assert.equal(round.phase, "lobby");
});
