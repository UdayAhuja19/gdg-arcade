// The party room's rules, driven with a fake clock.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRoom, MAX_PLAYERS, REJOIN_GRACE_MS, STUTTER_GAP_MS } from "../server/party/room.js";

function joinAll(room, count, now = 0) {
  return Array.from({ length: count }, (_, i) =>
    room.join({ clientId: `phone-000${i}`, name: `P${i}`, network: "wifi" }, now)
  );
}

function pingMany(room, clientId, rtt, count) {
  for (let i = 0; i < count; i += 1) room.recordPing(clientId, rtt);
}

test("phones get slots and brand colours in order, and a 5th is turned away", () => {
  const room = createRoom();
  const results = joinAll(room, MAX_PLAYERS);
  assert.deepEqual(
    results.map((r) => [r.player.slot, r.player.color]),
    [[0, "red"], [1, "blue"], [2, "yellow"], [3, "green"]]
  );
  assert.deepEqual(room.join({ clientId: "phone-extra", name: "LATE" }, 0), { full: true });
});

test("a phone that drops keeps its slot through the grace period, then loses it", () => {
  const room = createRoom();
  joinAll(room, 2);
  room.leave("phone-0000", 1000);

  const back = room.join({ clientId: "phone-0000", name: "P0" }, 5000);
  assert.equal(back.rejoined, true);
  assert.equal(back.player.slot, 0);
  assert.equal(back.player.reconnects, 1);
  assert.equal(back.player.network, "wifi", "keeps the last known network");

  room.leave("phone-0000", 10_000);
  assert.deepEqual(room.sweep(10_000 + REJOIN_GRACE_MS), [], "still inside the grace period");
  assert.equal(room.sweep(10_001 + REJOIN_GRACE_MS).length, 1);
  assert.equal(room.snapshot(0).players[0], null);

  // The freed slot goes to the next phone.
  assert.equal(room.join({ clientId: "phone-new1", name: "NEW" }, 0).player.slot, 0);
});

test("a dropout isn't counted as a stutter after rejoining", () => {
  const room = createRoom();
  joinAll(room, 1);
  room.recordUpdate("phone-0000", 0);
  room.leave("phone-0000", 50);
  room.join({ clientId: "phone-0000", name: "P0" }, 5000);
  room.recordUpdate("phone-0000", 5000);
  assert.equal(room.snapshot(5000).players[0].stutters, 0);
});

test("updates per second and stutters are measured from arrival times", () => {
  const room = createRoom();
  joinAll(room, 1);
  for (let t = 0; t <= 1000; t += 100) room.recordUpdate("phone-0000", t);
  room.recordUpdate("phone-0000", 1000 + STUTTER_GAP_MS + 1);
  const p = room.snapshot(1000 + STUTTER_GAP_MS + 1).players[0];
  assert.equal(p.stutters, 1);
  // Only the last second counts: the updates at 500-1000ms plus the late one.
  assert.equal(p.updatesPerSec, 7);

  // Stutters older than a minute drop off.
  assert.equal(room.snapshot(62_000).players[0].stutters, 0);
});

test("verdicts follow ping and stutter thresholds", () => {
  const room = createRoom();
  joinAll(room, 3);
  const verdict = () => room.snapshot(0).players.map((p) => p?.verdict ?? null);

  assert.deepEqual(verdict(), ["MEASURING", "MEASURING", "MEASURING", null]);
  assert.equal(room.snapshot(0).verdict.level, "waiting");

  pingMany(room, "phone-0000", 60, 20);
  pingMany(room, "phone-0001", 400, 20);
  pingMany(room, "phone-0002", 900, 20);
  assert.deepEqual(verdict(), ["GOOD", "OK", "LAGGY", null]);
  assert.equal(room.snapshot(0).verdict.level, "bad");

  room.kick(2);
  assert.equal(room.snapshot(0).verdict.level, "warn");
  room.kick(1);
  assert.deepEqual(room.snapshot(0).verdict, { level: "good", text: "READY FOR PARTY GAMES" });

  room.leave("phone-0000", 0);
  assert.equal(room.snapshot(0).players[0].verdict, "RECONNECTING");
  assert.equal(room.snapshot(0).verdict.level, "warn");
});

test("a missed ping stops a phone being GOOD only for a minute", () => {
  const room = createRoom();
  joinAll(room, 1);
  pingMany(room, "phone-0000", 50, 10);
  room.recordMissedPing("phone-0000", 1000);
  assert.equal(room.snapshot(1000).players[0].verdict, "OK");
  assert.equal(room.snapshot(1000).players[0].missedPings, 1);
  assert.equal(room.snapshot(62_000).players[0].verdict, "GOOD");
});

test("dropouts count against the verdict for a minute, and many make a phone LAGGY", () => {
  const room = createRoom();
  joinAll(room, 1);
  pingMany(room, "phone-0000", 50, 10);
  room.leave("phone-0000", 1000);
  room.join({ clientId: "phone-0000", name: "P0" }, 2000);
  let p = room.snapshot(2000).players[0];
  assert.equal(p.reconnects, 1);
  assert.equal(p.dropouts, 1);
  assert.equal(p.verdict, "OK");
  assert.equal(room.snapshot(63_000).players[0].verdict, "GOOD");

  for (let i = 0; i < 3; i += 1) {
    room.leave("phone-0000", 70_000 + i * 1000);
    room.join({ clientId: "phone-0000", name: "P0" }, 70_500 + i * 1000);
  }
  p = room.snapshot(73_000).players[0];
  assert.equal(p.dropouts, 3);
  assert.equal(p.verdict, "LAGGY");
});

test("a locked or backgrounded phone is PAUSED and nothing it does counts as lag", () => {
  const room = createRoom();
  joinAll(room, 1);
  pingMany(room, "phone-0000", 50, 10);
  room.recordUpdate("phone-0000", 0);

  room.setPaused("phone-0000", true);
  room.recordUpdate("phone-0000", 5000);
  room.recordPing("phone-0000", 9000);
  room.recordMissedPing("phone-0000", 5000);
  let p = room.snapshot(5000).players[0];
  assert.equal(p.verdict, "PAUSED");
  assert.equal(p.paused, true);
  assert.equal(p.updatesPerSec, 0);
  assert.equal(p.stutters, 0);
  assert.equal(p.missedPings, 0);
  assert.equal(p.p95, 50);
  assert.equal(room.snapshot(5000).verdict.level, "warn");

  // The lock dropped the connection: the rejoin shows, but isn't held against the network.
  room.leave("phone-0000", 6000);
  room.join({ clientId: "phone-0000", name: "P0" }, 9000);
  room.recordUpdate("phone-0000", 9000);
  p = room.snapshot(9000).players[0];
  assert.equal(p.paused, false);
  assert.equal(p.reconnects, 1);
  assert.equal(p.dropouts, 0);
  assert.equal(p.stutters, 0);
  assert.equal(p.verdict, "GOOD");
});

test("a phone whose pings never come back is LAGGY, not stuck on MEASURING", () => {
  const room = createRoom();
  joinAll(room, 2);
  for (let i = 0; i < 7; i += 1) room.recordMissedPing("phone-0000", 1000 + i);
  const snap = room.snapshot(2000);
  assert.equal(snap.players[0].verdict, "LAGGY");
  assert.equal(snap.players[1].verdict, "MEASURING");
  assert.equal(snap.verdict.level, "bad", "a lagging phone outranks one still measuring");
});

test("kick ignores slots that don't exist", () => {
  const room = createRoom();
  joinAll(room, 4);
  for (const slot of [-1, 4, 99, 1.5, "0"]) assert.equal(room.kick(slot), null);
  assert.equal(room.snapshot(0).players.length, MAX_PLAYERS);
  assert.equal(room.kick(3).name, "P3");
  assert.equal(room.join({ clientId: "phone-new1", name: "NEW" }, 0).player.slot, 3);
});

test("clear empties every slot and reports who was removed", () => {
  const room = createRoom();
  joinAll(room, 3);
  assert.equal(room.clear().length, 3);
  assert.deepEqual(room.snapshot(0).players, [null, null, null, null]);
});
