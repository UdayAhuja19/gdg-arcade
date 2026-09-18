// The GitHub Pages demo keeps scores in the browser. It should follow the same
// top-3 rules as the fair laptop's MySQL leaderboard.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  key: (i) => [...store.keys()][i] ?? null,
  get length() {
    return store.size;
  },
};

// Scores saved by an older version of the demo, before a reset.
store.set("gdg-arcade-demo-scores", JSON.stringify({ best: { dino: { old: { name: "OLD", score: 999, at: 1 } } } }));
store.set("unrelated-site-data", "keep me");

const { localApi, STORAGE_KEY } = await import("../public/js/local-api.js");

test("a reset clears scores saved by older versions and leaves other data alone", async () => {
  const boards = await localApi.boards();
  assert.deepEqual(boards.dino, []);
  assert.equal(store.has("gdg-arcade-demo-scores"), false);
  assert.equal(store.get("unrelated-site-data"), "keep me");
});

async function play(name, game, score) {
  const player = await localApi.createPlayer(name);
  const run = await localApi.startRun(game, player.id);
  return localApi.finishRun(run.runId, run.token, score);
}

beforeEach((t) => {
  if (!t.name.startsWith("a reset")) store.clear();
});

test("names follow the same rules as the server", async () => {
  assert.deepEqual(await localApi.createPlayer("  sara   k "), { id: "sara k", name: "SARA K" });
  await assert.rejects(localApi.createPlayer("x"), { status: 422 });
  await assert.rejects(localApi.createPlayer("f.u.c.k"), { status: 422 });
});

test("a name already in use is reported, in any case, so the home page can ask who's playing", async () => {
  assert.equal(await localApi.playerExists("Sara K"), false);
  await localApi.createPlayer("Sara K");
  assert.equal(await localApi.playerExists("sara   k"), true);
  assert.equal(await localApi.playerExists("SARA"), false);
  await assert.rejects(localApi.playerExists("x"), { status: 422 });
  // A name with saved scores counts too, even if the players list was lost.
  await play("Echo", "dino", 50);
  delete JSON.parse(store.get(STORAGE_KEY)).players;
  assert.equal(await localApi.playerExists("echo"), true);
});

test("first score is a new best at rank 1, a lower score keeps the best", async () => {
  const first = await play("Sara K", "dino", 120);
  assert.equal(first.isNewBest, true);
  assert.equal(first.rank, 1);
  const worse = await play("sara k", "dino", 80);
  assert.equal(worse.isNewBest, false);
  assert.equal(worse.best, 120);
  assert.deepEqual(worse.top3.map((r) => [r.name, r.score]), [["SARA K", 120]]);
});

test("top 3 only, earliest wins ties, and players outside see how far they are", async () => {
  await play("Alpha", "stack", 300);
  await new Promise((r) => setTimeout(r, 5));
  await play("Bravo", "stack", 300);
  await play("Charlie", "stack", 200);
  const delta = await play("Delta", "stack", 150);
  assert.deepEqual(delta.top3.map((r) => r.name), ["ALPHA", "BRAVO", "CHARLIE"]);
  assert.equal(delta.rank, 4);
  assert.equal(delta.pointsToTop3, 51);

  const boards = await localApi.boards();
  assert.equal(boards.stack.length, 3);
  assert.deepEqual(boards.dino, []);
});

test("a run can only be finished once and scores persist across reloads", async () => {
  const player = await localApi.createPlayer("Echo");
  const run = await localApi.startRun("snake", player.id);
  await localApi.finishRun(run.runId, run.token, 90);
  await assert.rejects(localApi.finishRun(run.runId, run.token, 900), { status: 409 });

  const stored = JSON.parse(store.get(STORAGE_KEY));
  assert.equal(stored.best.snake.echo.score, 90);
  const board = await localApi.board("snake", "echo");
  assert.deepEqual(board.me, { best: 90, rank: 1 });
});
