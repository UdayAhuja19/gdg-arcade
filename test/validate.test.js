import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeName, isBlocked } from "../public/js/shared/names.js";
import { getGame, checkScore } from "../server/games.js";

test("names are trimmed, spaces collapsed and uppercased", () => {
  assert.deepEqual(normalizeName("  sara   k "), { name: "SARA K", key: "sara k" });
});

test("names must be 2-16 allowed characters", () => {
  assert.ok(normalizeName("a").error);
  assert.ok(normalizeName("abcdefghijklmnopq").error);
  assert.ok(normalizeName("sara<script>").error);
  assert.ok(normalizeName("...").error);
  assert.ok(normalizeName(42).error);
  assert.equal(normalizeName("Ahmed_R-2.0").name, "AHMED_R-2.0");
});

test("blocklist catches disguised words", () => {
  for (const name of ["fuck", "F.U.C.K", "sh1t head", "a55", "b1tch"]) {
    assert.ok(isBlocked(name), `${name} should be blocked`);
  }
});

test("blocklist leaves real names alone", () => {
  for (const name of ["Hancock", "Cassie", "Essex", "Dickson", "Gandhi", "Sussex", "Randa", "Kostas"]) {
    assert.equal(isBlocked(name), false, `${name} should be allowed`);
  }
});

test("scores must be whole, non-negative and under the game cap", () => {
  const dino = getGame("dino");
  assert.ok(checkScore(dino, -1, 60));
  assert.ok(checkScore(dino, 1.5, 60));
  assert.ok(checkScore(dino, "100", 60));
  assert.ok(checkScore(dino, 100000, 99999));
  assert.equal(checkScore(dino, 500, 60), null);
});

test("scores that arrive faster than the game allows are rejected", () => {
  const dino = getGame("dino");
  // 20 pts/s x 1.5 margin + 100 slack
  assert.equal(checkScore(dino, 400, 10), null);
  assert.ok(checkScore(dino, 401, 10));
  // Memory has no rate cap, only a max score
  const memory = getGame("memory");
  assert.equal(checkScore(memory, 3000, 1), null);
  assert.ok(checkScore(memory, 3101, 1000));
});
