// A MASH BATTLE round (lobby -> countdown -> playing -> results), driven with a fake clock.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRound, LATE_REPORT_MS, MIN_PLAYERS, TIMING } from "../server/party/round.js";
import { MAX_TAPS_PER_SEC, MIN_FILL_MS, TAPS_TO_FILL, maxLevelAt } from "../public/js/shared/tap-battle.js";

const { countdownMs, roundMs, graceMs, finishWindowMs } = TIMING;
const GO = countdownMs; // rounds in these tests start at 0
const players = (n) =>
  Array.from({ length: n }, (_, i) => ({ clientId: `phone-${i}`, slot: i, color: "red", name: `P${i}` }));

function playing(n) {
  const round = createRound();
  round.start(players(n), 0);
  round.tick(GO);
  return round;
}

test("a round starts with fewer than 5 players, down to the minimum", () => {
  assert.equal(MIN_PLAYERS, 1);
  const round = createRound();
  assert.deepEqual(round.start([], 0), { error: "NEED AT LEAST 1 PLAYER TO START." });
  assert.equal(round.phase, "lobby");
  assert.deepEqual(round.start(players(1), 0), { ok: true });
  assert.equal(round.phase, "countdown");
  assert.equal(round.snapshot(0).bars.length, 1);
});

test("a round can't be started twice, but can be started again from the results", () => {
  const round = createRound();
  round.start(players(2), 0);
  assert.equal(round.start(players(2), 10).error, "A ROUND IS ALREADY RUNNING.");
  round.tick(GO);
  assert.equal(round.start(players(2), GO + 1).error, "A ROUND IS ALREADY RUNNING.");
  round.tick(GO + roundMs + graceMs);
  assert.equal(round.phase, "results");
  assert.deepEqual(round.start(players(3), 60_000), { ok: true });
  assert.equal(round.snapshot(60_000).number, 2);
  assert.deepEqual(round.snapshot(60_000).results, []);
});

test("with nobody filling the bar, the round ends at the time limit and the fullest bar wins", () => {
  const round = playing(3);
  round.report("phone-0", { level: 40 }, GO + 5000);
  round.report("phone-1", { level: 70 }, GO + 6000);
  round.report("phone-2", { level: 40 }, GO + 4000);
  assert.equal(round.tick(GO + roundMs), false, "reports are still taken during the grace period");
  assert.equal(round.tick(GO + roundMs + graceMs), true);
  assert.deepEqual(
    round.snapshot(0).results.map((r) => [r.rank, r.name, r.level]),
    [[1, "P1", 70], [2, "P2", 40], [3, "P0", 40]]
  );
});

test("the first full bar ends the round shortly after, and finish times decide the order", () => {
  const round = playing(3);
  const t = GO + 8000;
  round.report("phone-0", { level: 100, done: true, ms: 7900 }, t);
  assert.equal(round.snapshot(t).winner, "P0");
  assert.equal(round.viewFor("phone-0", t).youWon, true);
  assert.equal(round.viewFor("phone-1", t).youWon, false);

  // P1 filled a little earlier on its own clock, but its report arrived later.
  round.report("phone-1", { level: 100, done: true, ms: 7700 }, t + 600);
  round.report("phone-2", { level: 88 }, t + 700);
  assert.equal(round.tick(t + finishWindowMs - 1), false);
  assert.equal(round.tick(t + finishWindowMs), true);
  const { results } = round.snapshot(0);
  assert.deepEqual(
    results.map((r) => [r.rank, r.name, r.finishMs]),
    [[1, "P1", 7700], [2, "P0", 7900], [3, "P2", null]]
  );
  assert.deepEqual(round.viewFor("phone-2", 0).result, { rank: 3, of: 3, level: 88, finishMs: null });

  // The results are up. P2 was still reporting at the close, so its bar then is final.
  assert.equal(round.report("phone-2", { level: 99, final: true }, t + finishWindowMs + 1).status, "final");
  assert.equal(round.snapshot(0).results[2].level, 88);
});

test("reported bars are kept believable", () => {
  const round = createRound();
  round.start(players(1), 0);
  assert.equal(round.report("phone-0", { level: 5 }, GO - 100).status, "rejected", "nothing counts before GO");
  round.tick(GO);

  // Can't be fuller than the fastest possible tapping allows.
  const level = (lvl, at) => round.report("phone-0", { level: lvl }, at).entry.level;
  assert.equal(level(90, GO + 1000), maxLevelAt(1000) + 10);
  assert.equal(level(-20, GO + 1100), 0);
  assert.equal(round.report("phone-0", { level: "lots" }, GO + 1200).status, "rejected");
  assert.equal(level(500, GO + 20_000), 100);

  // A claimed finish time can't be faster than possible, or far behind the server's clock.
  const early = playing(2);
  early.report("phone-0", { level: 100, done: true, ms: 10 }, GO + 7000);
  assert.equal(early.entry("phone-0").finishMs, MIN_FILL_MS);
  early.report("phone-1", { level: 100, done: true, ms: 9000 }, GO + 7000);
  assert.equal(early.entry("phone-1").finishMs, 7000, "not later than the server saw it");

  // Once full, the bar is final.
  assert.equal(early.report("phone-0", { level: 20 }, GO + 7100).status, "final");
  assert.equal(early.entry("phone-0").level, 100);
  assert.equal(early.report("stranger", { level: 20 }, GO + 7100).status, "rejected", "only players in the round");
});

test("a full bar that beat the tap-speed cap isn't frozen below full: it counts once the cap catches up", () => {
  const round = playing(1);
  // Filled in 1s: faster than MAX_TAPS_PER_SEC allows.
  const full = { round: 1, level: 100, taps: 60, done: true, ms: 1000, final: true };
  assert.equal(round.report("phone-0", { ...full, seq: 1 }, GO + 1000).status, "capped");
  const held = round.entry("phone-0");
  assert.ok(held.level < 100);
  assert.equal(held.final, false, "not locked in at the capped level");
  assert.equal(held.finishMs, null);
  // The phone resends once a second; after the fastest possible fill the cap allows a full bar.
  assert.equal(round.report("phone-0", { ...full, seq: 2 }, GO + 3000).status, "capped");
  assert.equal(round.report("phone-0", { ...full, seq: 3 }, GO + MIN_FILL_MS + 100).status, "saved");
  assert.equal(round.entry("phone-0").level, 100);
  assert.equal(round.entry("phone-0").finishMs, MIN_FILL_MS, "credited with the fastest possible time");
  assert.equal(round.report("phone-0", { ...full, seq: 4 }, GO + MIN_FILL_MS + 200).status, "final");
});

test("a bar marked final can't change, and reports for another round are too late", () => {
  const round = playing(1);
  assert.equal(round.report("phone-0", { round: 1, level: 30, final: true }, GO + roundMs + 100).status, "saved");
  assert.equal(round.report("phone-0", { round: 1, level: 60, final: true }, GO + roundMs + 200).status, "final");
  assert.equal(round.entry("phone-0").level, 30);
  assert.equal(round.report("phone-0", { round: 7, level: 60 }, GO + roundMs + 300).status, "too-late");
});

test("a phone that was offline when the round closed still gets its final bar in", () => {
  const round = playing(3);
  const t = GO + 9000;
  round.report("phone-0", { level: 100, done: true, ms: 8900, taps: 70, final: true }, t);
  round.report("phone-1", { level: 40, taps: 30 }, GO + 6000); // then its connection dropped
  round.report("phone-2", { level: 50, taps: 35 }, GO + 6000); // same
  round.tick(t + finishWindowMs);
  assert.deepEqual(round.snapshot(0).results.map((r) => r.name), ["P0", "P2", "P1"]);

  // P1 filled its bar at 8.5s on its own clock while offline; it reconnects after the results.
  const late = round.report("phone-1", { round: 1, level: 100, done: true, ms: 8500, taps: 200, final: true }, t + 5000);
  assert.equal(late.status, "saved");
  assert.equal(late.late, true);
  assert.deepEqual(
    round.snapshot(0).results.map((r) => [r.rank, r.name, r.finishMs]),
    [[1, "P1", 8500], [2, "P0", 8900], [3, "P2", null]]
  );
  assert.equal(round.viewFor("phone-1", 0).result.rank, 1);
  // Sending it again changes nothing.
  const again = { round: 1, level: 100, done: true, ms: 8000, taps: 200, final: true };
  assert.equal(round.report("phone-1", again, t + 6000).status, "final");

  // P2's bar ended lower than the server last saw; its final level counts.
  assert.equal(round.report("phone-2", { round: 1, level: 12, taps: 40, final: true }, t + 7000).status, "saved");
  assert.equal(round.snapshot(0).results[2].level, 12);
});

test("a phone that was online when the round closed can't change its bar afterwards", () => {
  const round = playing(2);
  const t = GO + 8000;
  round.report("phone-0", { level: 100, done: true, ms: 7900, taps: 70, final: true }, t);
  round.report("phone-1", { level: 20, taps: 30 }, t + finishWindowMs - 200); // still reporting at the close
  round.tick(t + finishWindowMs);
  // It kept tapping after the results were up; that doesn't count.
  const after = round.report("phone-1", { round: 1, level: 100, done: true, ms: 12_000, taps: 90, final: true }, t + 4000);
  assert.equal(after.status, "final");
  assert.deepEqual(round.snapshot(0).results.map((r) => [r.name, r.level, r.finishMs]), [["P0", 100, 7900], ["P1", 20, null]]);
});

test("a late finish has to add up, and can't come in after the late window", () => {
  const round = playing(4);
  round.report("phone-0", { level: 100, done: true, ms: 6000, taps: 60, final: true }, GO + 6000);
  round.tick(GO + 6000 + finishWindowMs);
  const done = (id, ms, taps, at = GO + 10_000) =>
    round.report(id, { level: 100, done: true, ms, taps, final: true }, at).status;
  assert.equal(done("phone-1", 1000, 60), "rejected", "faster than anyone can tap");
  assert.equal(done("phone-1", 6000, TAPS_TO_FILL - 1), "rejected", "too few taps to fill the bar");
  assert.equal(done("phone-1", 6000, 500), "rejected", "more taps than possible in that time");
  assert.equal(done("phone-1", roundMs + 1, 60), "rejected", "after the time limit");
  assert.equal(done("phone-2", 7000, 80, GO + 6000 + finishWindowMs + LATE_REPORT_MS + 1), "too-late");
  assert.equal(done("phone-3", 7000, 180), "saved");
});

test("tap counts only go up and are capped", () => {
  const round = playing(1);
  round.report("phone-0", { level: 10, taps: 12 }, GO + 1000);
  round.report("phone-0", { level: 12, taps: 9 }, GO + 1100);
  assert.equal(round.entry("phone-0").taps, 12);
  round.report("phone-0", { level: 12, taps: 5000 }, GO + 2000);
  assert.equal(round.entry("phone-0").taps, 2 * MAX_TAPS_PER_SEC + 5, "2 seconds at the fastest tapping, plus a little slack");
});

test("each phone gets its own view of the round", () => {
  const round = createRound();
  round.start(players(1), 0);
  const view = round.viewFor("phone-0", 1000);
  assert.equal(view.phase, "countdown");
  assert.equal(view.inRound, true);
  assert.equal(view.endsInMs, countdownMs + roundMs - 1000);
  assert.equal(view.durationMs, roundMs);
  assert.equal(view.winner, null);
  assert.equal(round.viewFor("late-joiner", 1000).inRound, false);
});

test("someone removed drops out of the round and the results", () => {
  const round = playing(2);
  round.report("phone-0", { level: 30 }, GO + 2000);
  round.tick(GO + roundMs + graceMs);
  round.remove("phone-0");
  assert.deepEqual(round.snapshot(0).results.map((r) => [r.rank, r.name]), [[1, "P1"]]);
});

test("back to the lobby only from the results; reset works any time", () => {
  const round = createRound({ countdownMs: 10, roundMs: 10, graceMs: 0 });
  round.start(players(1), 0);
  assert.equal(round.toLobby(), false);
  round.tick(10);
  round.tick(20);
  assert.equal(round.phase, "results");
  assert.equal(round.toLobby(), true);
  assert.equal(round.phase, "lobby");
  assert.deepEqual(round.snapshot(0).bars, []);

  round.start(players(1), 100);
  round.reset();
  assert.equal(round.phase, "lobby");
});
